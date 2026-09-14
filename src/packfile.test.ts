import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readObjectFromPacks } from "./packfile.js";

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4, ofs_delta: 6, ref_delta: 7 };

type PackEntry =
  | { sha: string; type: "commit" | "tree" | "blob" | "tag"; content: Buffer }
  | { sha: string; type: "ofs_delta" | "ref_delta"; baseSha: string; deltaContent: Buffer; inflatedSize: number };

function fakeSha(id: string): string {
  return id.padEnd(40, "0");
}

function makeGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "packfile-test-"));
  mkdirSync(join(dir, "objects", "pack"), { recursive: true });
  return dir;
}

// Mirrors the bit layout readTypeAndSize expects: the type and the low 4
// bits of size share the first byte, then each continuation byte carries 7
// more bits of size.
function encodeTypeAndSize(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let firstByte = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) firstByte |= 0x80;
  bytes.push(firstByte);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

// OFS_DELTA's base-offset varint: each continuation byte adds 1 before
// shifting in the next 7 bits. Mirrors readOfsDeltaBaseOffset.
function encodeOfsDeltaOffset(offset: number): Buffer {
  const bytes: number[] = [offset & 0x7f];
  offset = Math.floor(offset / 128);
  while (offset > 0) {
    offset -= 1;
    bytes.push(0x80 | (offset & 0x7f));
    offset = Math.floor(offset / 128);
  }
  bytes.reverse();
  return Buffer.from(bytes);
}

// Plain LEB128, for the source/target size varints at the front of a delta
// instruction stream.
function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
}

// A delta that reproduces `target` purely through insert instructions,
// ignoring `base`'s actual bytes (legal — delta application never requires
// a copy instruction, just a source size that matches the real base).
function buildInsertOnlyDelta(baseLength: number, target: Buffer): Buffer {
  const parts: Buffer[] = [encodeVarint(baseLength), encodeVarint(target.length)];
  let offset = 0;
  while (offset < target.length) {
    const chunk = Math.min(127, target.length - offset);
    parts.push(Buffer.from([chunk]), target.subarray(offset, offset + chunk));
    offset += chunk;
  }
  return Buffer.concat(parts);
}

// A delta that copies every byte of `base` (via one copy instruction) then
// appends a literal suffix, exercising the copy-instruction opcode path.
function buildCopyThenInsertDelta(base: Buffer, suffix: Buffer): Buffer {
  const targetLength = base.length + suffix.length;
  const copyInstruction = Buffer.from([0x80 | 0x10, base.length]); // offset omitted (0), one size byte
  const insertInstruction = Buffer.concat([Buffer.from([suffix.length]), suffix]);
  return Buffer.concat([encodeVarint(base.length), encodeVarint(targetLength), copyInstruction, insertInstruction]);
}

function buildPack(entries: PackEntry[]): { pack: Buffer; offsets: Map<string, number> } {
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);

  const chunks: Buffer[] = [header];
  const offsets = new Map<string, number>();
  let offset = 12;

  for (const entry of entries) {
    const thisOffset = offset;
    offsets.set(entry.sha, thisOffset);

    const size = "content" in entry ? entry.content.length : entry.inflatedSize;
    const typeHeader = encodeTypeAndSize(TYPE_CODES[entry.type], size);
    chunks.push(typeHeader);
    offset += typeHeader.length;

    if (entry.type === "ofs_delta") {
      const baseOffset = offsets.get(entry.baseSha);
      if (baseOffset === undefined) throw new Error("ofs_delta base must be written earlier in the pack");
      const offsetBytes = encodeOfsDeltaOffset(thisOffset - baseOffset);
      const compressed = deflateSync(entry.deltaContent);
      chunks.push(offsetBytes, compressed);
      offset += offsetBytes.length + compressed.length;
    } else if (entry.type === "ref_delta") {
      const baseShaBytes = Buffer.from(entry.baseSha, "hex");
      const compressed = deflateSync(entry.deltaContent);
      chunks.push(baseShaBytes, compressed);
      offset += baseShaBytes.length + compressed.length;
    } else {
      const compressed = deflateSync(entry.content);
      chunks.push(compressed);
      offset += compressed.length;
    }
  }

  chunks.push(Buffer.alloc(20)); // trailer checksum, unused by the reader
  return { pack: Buffer.concat(chunks), offsets };
}

function buildIdx(offsets: Map<string, number>): Buffer {
  const entries = Array.from(offsets.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const count = entries.length;

  const fanout = new Array(256).fill(0);
  for (const [sha] of entries) {
    const firstByte = parseInt(sha.slice(0, 2), 16);
    for (let i = firstByte; i < 256; i++) fanout[i]++;
  }

  const header = Buffer.alloc(8);
  header.writeUInt32BE(0xff744f63, 0);
  header.writeUInt32BE(2, 4);

  const fanoutBuf = Buffer.alloc(256 * 4);
  for (let i = 0; i < 256; i++) fanoutBuf.writeUInt32BE(fanout[i], i * 4);

  const shaBuf = Buffer.concat(entries.map(([sha]) => Buffer.from(sha, "hex")));
  const crcBuf = Buffer.alloc(count * 4); // unused by the reader
  const offsetBuf = Buffer.alloc(count * 4);
  entries.forEach(([, offset], i) => offsetBuf.writeUInt32BE(offset, i * 4));

  return Buffer.concat([header, fanoutBuf, shaBuf, crcBuf, offsetBuf, Buffer.alloc(40)]);
}

function writePack(gitDir: string, name: string, entries: PackEntry[]): void {
  const packDir = join(gitDir, "objects", "pack");
  const { pack, offsets } = buildPack(entries);
  writeFileSync(join(packDir, `${name}.pack`), pack);
  writeFileSync(join(packDir, `${name}.idx`), buildIdx(offsets));
}

function writeLooseObject(gitDir: string, sha: string, type: string, content: Buffer): void {
  const header = Buffer.from(`${type} ${content.length}\0`, "ascii");
  const stored = deflateSync(Buffer.concat([header, content]));
  const dir = join(gitDir, "objects", sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha.slice(2)), stored);
}

test("reads a full (non-delta) object out of a packfile", () => {
  const gitDir = makeGitDir();
  const sha = fakeSha("blob1");
  const content = Buffer.from("hello from a packfile\n", "utf8");

  writePack(gitDir, "pack-a", [{ sha, type: "blob", content }]);

  const result = readObjectFromPacks(gitDir, sha);

  assert.equal(result?.type, "blob");
  assert.deepEqual(result?.content, content);
});

test("returns null for a sha that isn't in any pack", () => {
  const gitDir = makeGitDir();
  writePack(gitDir, "pack-a", [{ sha: fakeSha("blob1"), type: "blob", content: Buffer.from("x") }]);

  assert.equal(readObjectFromPacks(gitDir, fakeSha("missing")), null);
});

test("resolves a REF_DELTA object against a base earlier in the same pack", () => {
  const gitDir = makeGitDir();
  const baseSha = fakeSha("base");
  const baseContent = Buffer.from("version one of the file\n", "utf8");
  const deltaSha = fakeSha("delta");
  const targetContent = Buffer.from("version two of the file, totally different text\n", "utf8");
  const deltaContent = buildInsertOnlyDelta(baseContent.length, targetContent);

  writePack(gitDir, "pack-a", [
    { sha: baseSha, type: "blob", content: baseContent },
    { sha: deltaSha, type: "ref_delta", baseSha, deltaContent, inflatedSize: deltaContent.length },
  ]);

  const result = readObjectFromPacks(gitDir, deltaSha);

  assert.equal(result?.type, "blob");
  assert.deepEqual(result?.content, targetContent);
});

test("resolves an OFS_DELTA object using a copy instruction plus a literal insert", () => {
  const gitDir = makeGitDir();
  const baseSha = fakeSha("base");
  const baseContent = Buffer.from("ABCDEFGHIJ", "ascii");
  const suffix = Buffer.from("!", "ascii");
  const deltaSha = fakeSha("delta");
  const deltaContent = buildCopyThenInsertDelta(baseContent, suffix);

  writePack(gitDir, "pack-a", [
    { sha: baseSha, type: "blob", content: baseContent },
    { sha: deltaSha, type: "ofs_delta", baseSha, deltaContent, inflatedSize: deltaContent.length },
  ]);

  const result = readObjectFromPacks(gitDir, deltaSha);

  assert.equal(result?.type, "blob");
  assert.deepEqual(result?.content, Buffer.from("ABCDEFGHIJ!", "ascii"));
});

test("resolves a REF_DELTA whose base is a loose object outside the pack", () => {
  const gitDir = makeGitDir();
  const baseSha = fakeSha("base");
  const baseContent = Buffer.from("loose base content\n", "utf8");
  writeLooseObject(gitDir, baseSha, "blob", baseContent);

  const deltaSha = fakeSha("delta");
  const targetContent = Buffer.from("target content built from a delta\n", "utf8");
  const deltaContent = buildInsertOnlyDelta(baseContent.length, targetContent);

  writePack(gitDir, "pack-a", [
    { sha: deltaSha, type: "ref_delta", baseSha, deltaContent, inflatedSize: deltaContent.length },
  ]);

  const result = readObjectFromPacks(gitDir, deltaSha);

  assert.equal(result?.type, "blob");
  assert.deepEqual(result?.content, targetContent);
});

test("chains an OFS_DELTA on top of a REF_DELTA base", () => {
  const gitDir = makeGitDir();
  const rootSha = fakeSha("root");
  const rootContent = Buffer.from("root content\n", "utf8");
  const midSha = fakeSha("mid");
  const midContent = Buffer.from("middle generation content\n", "utf8");
  const midDelta = buildInsertOnlyDelta(rootContent.length, midContent);
  const leafSha = fakeSha("leaf");
  const leafSuffix = Buffer.from(" plus more", "ascii");
  const leafDelta = buildCopyThenInsertDelta(midContent, leafSuffix);

  writePack(gitDir, "pack-a", [
    { sha: rootSha, type: "blob", content: rootContent },
    { sha: midSha, type: "ref_delta", baseSha: rootSha, deltaContent: midDelta, inflatedSize: midDelta.length },
    { sha: leafSha, type: "ofs_delta", baseSha: midSha, deltaContent: leafDelta, inflatedSize: leafDelta.length },
  ]);

  const result = readObjectFromPacks(gitDir, leafSha);

  assert.equal(result?.type, "blob");
  assert.deepEqual(result?.content, Buffer.concat([midContent, leafSuffix]));
});
