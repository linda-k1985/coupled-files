// Reads objects out of .git/objects/pack/*.pack, the format `git gc` and
// ordinary clones use instead of one loose file per object. Each pack has a
// sorted companion .idx file mapping object shas to byte offsets in the
// pack; objects are stored back to back with no padding, either as a
// zlib-deflated full object or as a delta (a small set of copy/insert
// instructions) against another object, which may itself be a delta.
//
// Only idx version 2 is handled — that's what `git repack`/`git gc` have
// produced by default for two decades, so version 1 (pre-2005, no magic
// number, no per-object CRC) isn't worth the extra code path.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { readLooseObject } from "./looseobject.js";

export interface RawObject {
  type: string;
  content: Buffer;
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_NAMES: Record<number, string> = {
  [OBJ_COMMIT]: "commit",
  [OBJ_TREE]: "tree",
  [OBJ_BLOB]: "blob",
  [OBJ_TAG]: "tag",
};

const IDX_MAGIC = 0xff744f63; // "\377tOc"
const PACK_MAGIC = 0x5041434b; // "PACK"

interface PackIndex {
  packPath: string;
  offsetBySha: Map<string, number>;
  sortedOffsets: number[];
}

// Keyed by the objects/pack directory, so a repo's indexes are parsed once
// per run no matter how many objects we end up looking up.
const packIndexCache = new Map<string, PackIndex[]>();
const packBufferCache = new Map<string, Buffer>();
const resolvedObjectCache = new Map<string, Map<number, RawObject>>();

function parseIdx(idxPath: string, packPath: string): PackIndex {
  const buf = readFileSync(idxPath);
  if (buf.readUInt32BE(0) !== IDX_MAGIC) {
    throw new Error(`${idxPath}: not a version 2 idx file (missing magic number)`);
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) {
    throw new Error(`${idxPath}: unsupported idx version ${version}, only version 2 is supported`);
  }

  const fanoutStart = 8;
  const count = buf.readUInt32BE(fanoutStart + 255 * 4);

  const shaStart = fanoutStart + 256 * 4;
  const offsetStart = shaStart + count * 20 + count * 4; // shas, then a 4-byte CRC32 per object
  const largeOffsetStart = offsetStart + count * 4;

  const offsetBySha = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const sha = buf.subarray(shaStart + i * 20, shaStart + i * 20 + 20).toString("hex");
    const raw = buf.readUInt32BE(offsetStart + i * 4);
    let offset: number;
    if (raw & 0x80000000) {
      const largeIndex = raw & 0x7fffffff;
      const high = buf.readUInt32BE(largeOffsetStart + largeIndex * 8);
      const low = buf.readUInt32BE(largeOffsetStart + largeIndex * 8 + 4);
      offset = high * 2 ** 32 + low;
    } else {
      offset = raw;
    }
    offsetBySha.set(sha, offset);
  }

  const sortedOffsets = Array.from(offsetBySha.values()).sort((a, b) => a - b);
  return { packPath, offsetBySha, sortedOffsets };
}

function loadPackIndexes(gitDir: string): PackIndex[] {
  const packDir = join(gitDir, "objects", "pack");
  const cached = packIndexCache.get(packDir);
  if (cached) return cached;

  const indexes: PackIndex[] = [];
  if (existsSync(packDir)) {
    for (const name of readdirSync(packDir)) {
      if (!name.endsWith(".idx")) continue;
      const packPath = join(packDir, name.slice(0, -".idx".length) + ".pack");
      if (existsSync(packPath)) {
        indexes.push(parseIdx(join(packDir, name), packPath));
      }
    }
  }
  packIndexCache.set(packDir, indexes);
  return indexes;
}

function loadPackBuffer(packPath: string): Buffer {
  const cached = packBufferCache.get(packPath);
  if (cached) return cached;

  const buf = readFileSync(packPath);
  if (buf.readUInt32BE(0) !== PACK_MAGIC) {
    throw new Error(`${packPath}: missing PACK signature`);
  }
  packBufferCache.set(packPath, buf);
  return buf;
}

function getResolvedCache(packPath: string): Map<number, RawObject> {
  let cache = resolvedObjectCache.get(packPath);
  if (!cache) {
    cache = new Map();
    resolvedObjectCache.set(packPath, cache);
  }
  return cache;
}

// The 3-bit type plus size are packed into a variable number of bytes: the
// low 4 bits of the size are in the first byte alongside the type, then
// each following byte (while the continuation bit is set) contributes 7
// more bits.
function readTypeAndSize(buf: Buffer, offset: number): { type: number; nextOffset: number } {
  let byte = buf[offset];
  offset += 1;
  const type = (byte >> 4) & 0x7;
  while (byte & 0x80) {
    byte = buf[offset];
    offset += 1;
  }
  return { type, nextOffset: offset };
}

// The base offset for an OFS_DELTA uses its own variable-length encoding
// (distinct from the delta stream's plain LEB128 varints below): each
// continuation byte adds 1 before shifting in the next 7 bits, which lets
// the same offset be spelled with one fewer byte than plain LEB128 would.
function readOfsDeltaBaseOffset(buf: Buffer, offset: number): { baseOffsetDelta: number; nextOffset: number } {
  let byte = buf[offset];
  offset += 1;
  let result = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[offset];
    offset += 1;
    result += 1;
    result = result * 128 + (byte & 0x7f);
  }
  return { baseOffsetDelta: result, nextOffset: offset };
}

function readDeltaVarint(buf: Buffer, offset: number): { value: number; nextOffset: number } {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = buf[offset];
    offset += 1;
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, nextOffset: offset };
}

// Applies a git delta (as produced by diff-delta.c) to reconstruct the
// target object. The instruction stream is a sequence of copy-from-base and
// insert-literal opcodes; multiplying instead of shifting for the copy
// offset/size keeps this correct past the 32-bit range bitwise ops wrap at.
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const sourceSize = readDeltaVarint(delta, 0);
  const targetSize = readDeltaVarint(delta, sourceSize.nextOffset);
  if (sourceSize.value !== base.length) {
    throw new Error("delta base size does not match the actual base object — pack data looks corrupt");
  }

  const target = Buffer.alloc(targetSize.value);
  let targetOffset = 0;
  let offset = targetSize.nextOffset;

  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;

    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) copyOffset += delta[offset++] * 2 ** 0;
      if (opcode & 0x02) copyOffset += delta[offset++] * 2 ** 8;
      if (opcode & 0x04) copyOffset += delta[offset++] * 2 ** 16;
      if (opcode & 0x08) copyOffset += delta[offset++] * 2 ** 24;
      if (opcode & 0x10) copySize += delta[offset++] * 2 ** 0;
      if (opcode & 0x20) copySize += delta[offset++] * 2 ** 8;
      if (opcode & 0x40) copySize += delta[offset++] * 2 ** 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(target, targetOffset, copyOffset, copyOffset + copySize);
      targetOffset += copySize;
    } else if (opcode !== 0) {
      delta.copy(target, targetOffset, offset, offset + opcode);
      offset += opcode;
      targetOffset += opcode;
    } else {
      throw new Error("invalid delta opcode 0 — pack data looks corrupt");
    }
  }

  return target;
}

function nextOffsetBoundary(index: PackIndex, offset: number, packLength: number): number {
  const sorted = index.sortedOffsets;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1 < sorted.length ? sorted[lo + 1] : packLength - 20; // 20-byte trailer checksum
}

function resolveObjectAtOffset(
  gitDir: string,
  index: PackIndex,
  packBuf: Buffer,
  offset: number,
  cache: Map<number, RawObject>,
): RawObject {
  const cached = cache.get(offset);
  if (cached) return cached;

  const header = readTypeAndSize(packBuf, offset);
  const boundary = nextOffsetBoundary(index, offset, packBuf.length);

  if (header.type in TYPE_NAMES) {
    const content = inflateSync(packBuf.subarray(header.nextOffset, boundary));
    const result = { type: TYPE_NAMES[header.type], content };
    cache.set(offset, result);
    return result;
  }

  if (header.type === OBJ_OFS_DELTA) {
    const { baseOffsetDelta, nextOffset } = readOfsDeltaBaseOffset(packBuf, header.nextOffset);
    const base = resolveObjectAtOffset(gitDir, index, packBuf, offset - baseOffsetDelta, cache);
    const deltaData = inflateSync(packBuf.subarray(nextOffset, boundary));
    const result = { type: base.type, content: applyDelta(base.content, deltaData) };
    cache.set(offset, result);
    return result;
  }

  if (header.type === OBJ_REF_DELTA) {
    const baseSha = packBuf.subarray(header.nextOffset, header.nextOffset + 20).toString("hex");
    const deltaStart = header.nextOffset + 20;
    const baseOffset = index.offsetBySha.get(baseSha);
    const base = baseOffset !== undefined
      ? resolveObjectAtOffset(gitDir, index, packBuf, baseOffset, cache)
      : resolveObjectBySha(gitDir, baseSha);
    const deltaData = inflateSync(packBuf.subarray(deltaStart, boundary));
    const result = { type: base.type, content: applyDelta(base.content, deltaData) };
    cache.set(offset, result);
    return result;
  }

  throw new Error(`unsupported pack object type ${header.type} at offset ${offset} in ${index.packPath}`);
}

// Falls back to any object the pack can see, loose or in another pack, for
// a REF_DELTA whose base wasn't packed alongside it — normal after `git gc`
// packs everything self-contained, but thin packs (e.g. straight off the
// wire from a fetch, before `index-pack` fixes them up) can reference a
// base the receiver already had.
function resolveObjectBySha(gitDir: string, sha: string): RawObject {
  const loose = readLooseObject(gitDir, sha);
  if (loose) return loose;
  const packed = readObjectFromPacks(gitDir, sha);
  if (packed) return packed;
  throw new Error(
    `delta base object ${sha} isn't a loose object or in any packfile — the pack looks incomplete`,
  );
}

export function readObjectFromPacks(gitDir: string, sha: string): RawObject | null {
  for (const index of loadPackIndexes(gitDir)) {
    const offset = index.offsetBySha.get(sha);
    if (offset === undefined) continue;
    const packBuf = loadPackBuffer(index.packPath);
    const cache = getResolvedCache(index.packPath);
    return resolveObjectAtOffset(gitDir, index, packBuf, offset, cache);
  }
  return null;
}
