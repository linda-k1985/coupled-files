// Reads commits straight out of a .git directory's object database instead
// of relying on a piped `git log` invocation. Objects are looked up as
// loose files first, falling back to any packfile under objects/pack —
// between them that covers a repo at any point after a clone or `git gc`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Commit } from "./parser.js";
import { readLooseObject } from "./looseobject.js";
import { readObjectFromPacks } from "./packfile.js";
import { profileLines, similarity, type LineProfile } from "./similarity.js";

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

interface ChangedBlob {
  path: string;
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
  const loose = readLooseObject(gitDir, sha);
  if (loose) return loose;

  const packed = readObjectFromPacks(gitDir, sha);
  if (packed) return packed;

  throw new Error(
    `object ${sha} was not found as a loose object or in any packfile under ${join(gitDir, "objects")}`,
  );
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
// directory at the same path are not specially reconciled. Entries that
// only exist on one side are split into `removed`/`added` rather than
// dumped straight into `modified`, so the caller can pair them back up
// into renames.
function diffTrees(
  gitDir: string,
  treeSha: string | null,
  parentTreeSha: string | null,
  prefix: string,
  modified: string[],
  removed: ChangedBlob[],
  added: ChangedBlob[],
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
      diffTrees(
        gitDir,
        hereIsTree ? here!.sha : null,
        thereIsTree ? there!.sha : null,
        path,
        modified,
        removed,
        added,
      );
    } else if (here && there) {
      modified.push(path);
    } else if (here) {
      added.push({ path, sha: here.sha });
    } else if (there) {
      removed.push({ path, sha: there.sha });
    }
  }
}

// Same default as git's -M: half the content has to survive.
const RENAME_SIMILARITY_THRESHOLD = 0.5;

// Comparing every leftover delete against every leftover add is quadratic
// in blob reads, so a commit that shuffles a huge number of files skips the
// similarity pass and keeps only the exact matches. git has the same kind
// of cutoff (diff.renameLimit).
const SIMILARITY_PAIR_LIMIT = 2500;

// Pairs up removed and added paths and folds each pair into a single
// touched path, the way `git log -M --name-only` collapses a rename. Exact
// blob matches go first; whatever is left over is matched by content
// similarity so a file that was moved and edited in the same commit still
// counts as one rename. Blobs that can't be read are simply never similar.
function foldRenames(gitDir: string, removed: ChangedBlob[], added: ChangedBlob[]): string[] {
  const addedBySha = new Map<string, ChangedBlob[]>();
  for (const entry of added) {
    const bucket = addedBySha.get(entry.sha);
    if (bucket) bucket.push(entry);
    else addedBySha.set(entry.sha, [entry]);
  }

  const renamedTo = new Set<string>();
  const renamedFrom = new Set<string>();

  for (const entry of removed) {
    const candidates = addedBySha.get(entry.sha);
    const match = candidates?.find((candidate) => !renamedTo.has(candidate.path));
    if (match) {
      renamedTo.add(match.path);
      renamedFrom.add(entry.path);
    }
  }

  const leftoverRemoved = removed.filter((entry) => !renamedFrom.has(entry.path));
  const leftoverAdded = added.filter((entry) => !renamedTo.has(entry.path));
  if (
    leftoverRemoved.length > 0 &&
    leftoverAdded.length > 0 &&
    leftoverRemoved.length * leftoverAdded.length <= SIMILARITY_PAIR_LIMIT
  ) {
    const profiles = new Map<string, LineProfile | null>();
    const profileOf = (sha: string): LineProfile | null => {
      if (profiles.has(sha)) return profiles.get(sha)!;
      let profile: LineProfile | null = null;
      try {
        const { type, content } = readObject(gitDir, sha);
        if (type === "blob") profile = profileLines(content);
      } catch {
        profile = null;
      }
      profiles.set(sha, profile);
      return profile;
    };

    const scored: { from: string; to: string; score: number }[] = [];
    for (const from of leftoverRemoved) {
      const fromProfile = profileOf(from.sha);
      if (!fromProfile) continue;
      for (const to of leftoverAdded) {
        const toProfile = profileOf(to.sha);
        if (!toProfile) continue;
        const score = similarity(fromProfile, toProfile);
        if (score >= RENAME_SIMILARITY_THRESHOLD) scored.push({ from: from.path, to: to.path, score });
      }
    }

    // Best matches claim their files first so one popular target doesn't
    // get taken by a weaker candidate.
    scored.sort((a, b) => b.score - a.score);
    for (const { from, to } of scored) {
      if (renamedFrom.has(from) || renamedTo.has(to)) continue;
      renamedFrom.add(from);
      renamedTo.add(to);
    }
  }

  // A rename is reported once, under its new path. The exact pass above
  // recorded destinations, so emit every added path plus the removed paths
  // that found no partner.
  const paths: string[] = [];
  for (const entry of removed) {
    if (!renamedFrom.has(entry.path)) paths.push(entry.path);
  }
  for (const entry of added) paths.push(entry.path);
  return paths;
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
    const modified: string[] = [];
    const removed: ChangedBlob[] = [];
    const added: ChangedBlob[] = [];
    diffTrees(gitDir, commit.tree, parentTree, "", modified, removed, added);
    const files = modified.concat(foldRenames(gitDir, removed, added));
    if (files.length > 0) {
      commits.push({ date: commit.date, files });
    }
  }

  return commits;
}
