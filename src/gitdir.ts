// Reads commits straight out of a .git directory's object database instead
// of relying on a piped `git log` invocation. Only loose objects are
// understood — once a repo has been packed (git gc, or most clones) its
// objects live in .git/objects/pack/*.pack instead, and we don't parse
// those yet. Callers get a clear error pointing at the git log fallback
// rather than silently missing history.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Commit } from "./parser.js";

interface RawCommit {
  tree: string;
  parents: string[];
  date: string;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

const DIRECTORY_MODE = "40000";

function resolveGitDir(path: string): string {
  if (existsSync(join(path, "HEAD"))) {
    return path;
  }
  if (existsSync(join(path, ".git", "HEAD"))) {
    return join(path, ".git");
  }
  throw new Error(`${path} does not look like a git directory (no HEAD file found)`);
}

function resolvePackedRef(gitDir: string, ref: string): string | null {
  const packedRefsPath = join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) return null;

  for (const line of readFileSync(packedRefsPath, "utf8").split("\n")) {
    if (line.startsWith("#") || line.startsWith("^") || line.trim() === "") continue;
    const spaceIndex = line.indexOf(" ");
    if (line.slice(spaceIndex + 1).trim() === ref) {
      return line.slice(0, spaceIndex).trim();
    }
  }
  return null;
}

function resolveRef(gitDir: string, ref: string): string {
  const path = join(gitDir, ref);
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const packed = resolvePackedRef(gitDir, ref);
  if (packed) return packed;
  throw new Error(`could not resolve ref ${ref}`);
}

function resolveHead(gitDir: string): string {
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (head.startsWith("ref: ")) {
    return resolveRef(gitDir, head.slice("ref: ".length));
  }
  return head;
}

function readObject(gitDir: string, sha: string): { type: string; content: Buffer } {
  const path = join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
  if (!existsSync(path)) {
    throw new Error(
      `object ${sha} isn't stored as a loose object, likely because the repo has been packed ` +
        `(git gc or a normal clone does this). Reading packfiles directly isn't supported yet — ` +
        `pipe "git log --name-only --pretty=format:'commit:%H %aI'" into the tool instead.`,
    );
  }
  const raw = inflateSync(readFileSync(path));
  const nullIndex = raw.indexOf(0);
  const type = raw.subarray(0, nullIndex).toString("ascii").split(" ")[0];
  return { type, content: raw.subarray(nullIndex + 1) };
}

function parseTree(gitDir: string, sha: string): TreeEntry[] {
  const { type, content } = readObject(gitDir, sha);
  if (type !== "tree") {
    throw new Error(`expected a tree object at ${sha}, found ${type}`);
  }

  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const spaceIndex = content.indexOf(0x20, offset);
    const mode = content.subarray(offset, spaceIndex).toString("ascii");
    const nullIndex = content.indexOf(0, spaceIndex);
    const name = content.subarray(spaceIndex + 1, nullIndex).toString("utf8");
    const entrySha = content.subarray(nullIndex + 1, nullIndex + 21).toString("hex");
    entries.push({ mode, name, sha: entrySha });
    offset = nullIndex + 21;
  }
  return entries;
}

function formatAuthorDate(unixSeconds: number, tzOffset: string): string {
  const sign = tzOffset[0] === "-" ? -1 : 1;
  const offsetHours = Number(tzOffset.slice(1, 3));
  const offsetMinutes = Number(tzOffset.slice(3, 5));
  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  const local = new Date(unixSeconds * 1000 + offsetMs);

  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const timePart = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const offsetSign = sign === -1 ? "-" : "+";
  const offsetPart = `${offsetSign}${tzOffset.slice(1, 3)}:${tzOffset.slice(3, 5)}`;
  return `${datePart}T${timePart}${offsetPart}`;
}

function parseCommit(content: Buffer): RawCommit {
  const text = content.toString("utf8");
  let tree = "";
  const parents: string[] = [];
  let date = "";

  for (const line of text.split("\n")) {
    if (line === "") break;
    if (line.startsWith("tree ")) {
      tree = line.slice("tree ".length);
    } else if (line.startsWith("parent ")) {
      parents.push(line.slice("parent ".length));
    } else if (line.startsWith("author ")) {
      const match = line.match(/(\d+) ([+-]\d{4})$/);
      if (match) date = formatAuthorDate(Number(match[1]), match[2]);
    }
  }

  return { tree, parents, date };
}

// Mirrors `git log --name-only`'s default: paths whose blob or mode
// changed between the two trees, recursing into subtrees, skipping any
// subtree whose sha is unchanged. Type changes between a file and a
// directory at the same path are not specially reconciled.
function diffTrees(
  gitDir: string,
  treeSha: string | null,
  parentTreeSha: string | null,
  prefix: string,
  files: string[],
): void {
  if (treeSha === parentTreeSha) return;

  const current = new Map((treeSha ? parseTree(gitDir, treeSha) : []).map((e) => [e.name, e]));
  const previous = new Map((parentTreeSha ? parseTree(gitDir, parentTreeSha) : []).map((e) => [e.name, e]));
  const names = new Set([...current.keys(), ...previous.keys()]);

  for (const name of names) {
    const here = current.get(name);
    const there = previous.get(name);
    if (here?.sha === there?.sha && here?.mode === there?.mode) continue;

    const path = prefix ? `${prefix}/${name}` : name;
    const hereIsTree = here?.mode === DIRECTORY_MODE;
    const thereIsTree = there?.mode === DIRECTORY_MODE;

    if (hereIsTree || thereIsTree) {
      diffTrees(gitDir, hereIsTree ? here!.sha : null, thereIsTree ? there!.sha : null, path, files);
    } else {
      files.push(path);
    }
  }
}

export function readCommitsFromGitDir(path: string): Commit[] {
  const gitDir = resolveGitDir(path);
  const headSha = resolveHead(gitDir);

  const commitCache = new Map<string, RawCommit>();
  function loadCommit(sha: string): RawCommit {
    const cached = commitCache.get(sha);
    if (cached) return cached;
    const { type, content } = readObject(gitDir, sha);
    if (type !== "commit") {
      throw new Error(`expected a commit object at ${sha}, found ${type}`);
    }
    const commit = parseCommit(content);
    commitCache.set(sha, commit);
    return commit;
  }

  const commits: Commit[] = [];
  const seen = new Set<string>();
  const queue: string[] = [headSha];

  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);

    const commit = loadCommit(sha);
    queue.push(...commit.parents);

    // A merge diffed against more than one parent is ambiguous, so plain
    // `git log --name-only` shows no files for it by default. Match that.
    if (commit.parents.length > 1) continue;

    const parentTree = commit.parents.length === 1 ? loadCommit(commit.parents[0]).tree : null;
    const files: string[] = [];
    diffTrees(gitDir, commit.tree, parentTree, "", files);
    if (files.length > 0) {
      commits.push({ date: commit.date, files });
    }
  }

  return commits;
}
