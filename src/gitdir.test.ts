import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readCommitsFromGitDir } from "./gitdir.js";

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function makeGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitdir-test-"));
  mkdirSync(join(dir, "objects"), { recursive: true });
  mkdirSync(join(dir, "refs", "heads"), { recursive: true });
  return dir;
}

function fakeSha(id: string): string {
  return id.padEnd(40, "0");
}

function writeLooseObject(gitDir: string, sha: string, type: string, content: Buffer): void {
  const header = Buffer.from(`${type} ${content.length}\0`, "ascii");
  const stored = deflateSync(Buffer.concat([header, content]));
  const dir = join(gitDir, "objects", sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha.slice(2)), stored);
}

function writeTree(gitDir: string, sha: string, entries: TreeEntry[]): void {
  const parts = entries.map((entry) =>
    Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, "ascii"), Buffer.from(entry.sha, "hex")]),
  );
  writeLooseObject(gitDir, sha, "tree", Buffer.concat(parts));
}

function writeCommit(gitDir: string, sha: string, tree: string, parents: string[], authorLine: string): void {
  const parentLines = parents.map((parent) => `parent ${parent}\n`).join("");
  const content = `tree ${tree}\n${parentLines}author ${authorLine}\ncommitter ${authorLine}\n\nmessage\n`;
  writeLooseObject(gitDir, sha, "commit", Buffer.from(content, "utf8"));
}

function setHead(gitDir: string, commit: string): void {
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitDir, "refs", "heads", "main"), `${commit}\n`);
}

test("reads a root commit and reports every file in its tree", () => {
  const gitDir = makeGitDir();
  const tree = fakeSha("t1");
  const commit = fakeSha("c1");

  writeTree(gitDir, tree, [
    { mode: "100644", name: "a.ts", sha: fakeSha("a") },
    { mode: "100644", name: "b.ts", sha: fakeSha("b") },
  ]);
  writeCommit(gitDir, commit, tree, [], "Jane Doe <jane@example.com> 0 +0000");
  setHead(gitDir, commit);

  const commits = readCommitsFromGitDir(gitDir);

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files.sort(), ["a.ts", "b.ts"]);
  assert.equal(commits[0].date, "1970-01-01T00:00:00+00:00");
});

test("applies the author timezone offset when formatting the date", () => {
  const gitDir = makeGitDir();
  const tree = fakeSha("t1");
  const commit = fakeSha("c1");

  writeTree(gitDir, tree, [{ mode: "100644", name: "a.ts", sha: fakeSha("a") }]);
  // 3600 seconds past the epoch, one hour west: local wall-clock time is the epoch itself.
  writeCommit(gitDir, commit, tree, [], "Jane Doe <jane@example.com> 3600 -0100");
  setHead(gitDir, commit);

  const commits = readCommitsFromGitDir(gitDir);

  assert.equal(commits[0].date, "1970-01-01T00:00:00-01:00");
});

test("diffs a commit against its parent instead of listing the whole tree", () => {
  const gitDir = makeGitDir();
  const parentTree = fakeSha("t1");
  const childTree = fakeSha("t2");
  const parentCommit = fakeSha("c1");
  const childCommit = fakeSha("c2");

  writeTree(gitDir, parentTree, [
    { mode: "100644", name: "a.ts", sha: fakeSha("a") },
    { mode: "100644", name: "b.ts", sha: fakeSha("b") },
  ]);
  writeTree(gitDir, childTree, [
    { mode: "100644", name: "a.ts", sha: fakeSha("a") }, // unchanged
    { mode: "100644", name: "b.ts", sha: fakeSha("bb") }, // modified
    { mode: "100644", name: "c.ts", sha: fakeSha("c") }, // added
  ]);
  writeCommit(gitDir, parentCommit, parentTree, [], "Jane Doe <jane@example.com> 0 +0000");
  writeCommit(gitDir, childCommit, childTree, [parentCommit], "Jane Doe <jane@example.com> 100 +0000");
  setHead(gitDir, childCommit);

  const commits = readCommitsFromGitDir(gitDir);

  assert.equal(commits.length, 2);
  const child = commits.find((c) => c.date === "1970-01-01T00:01:40+00:00");
  assert.deepEqual(child?.files.sort(), ["b.ts", "c.ts"]);
});

test("recurses into unchanged-sha subtrees skipping only the parts that differ", () => {
  const gitDir = makeGitDir();
  const sharedSubtree = fakeSha("55");
  const parentTree = fakeSha("t1");
  const childTree = fakeSha("t2");
  const parentCommit = fakeSha("c1");
  const childCommit = fakeSha("c2");

  writeTree(gitDir, sharedSubtree, [{ mode: "100644", name: "deep.ts", sha: fakeSha("d") }]);
  writeTree(gitDir, parentTree, [
    { mode: "100644", name: "top.ts", sha: fakeSha("aa1") },
    { mode: "40000", name: "lib", sha: sharedSubtree },
  ]);
  writeTree(gitDir, childTree, [
    { mode: "100644", name: "top.ts", sha: fakeSha("aa2") },
    { mode: "40000", name: "lib", sha: sharedSubtree },
  ]);
  writeCommit(gitDir, parentCommit, parentTree, [], "Jane Doe <jane@example.com> 0 +0000");
  writeCommit(gitDir, childCommit, childTree, [parentCommit], "Jane Doe <jane@example.com> 100 +0000");
  setHead(gitDir, childCommit);

  const commits = readCommitsFromGitDir(gitDir);
  const child = commits.find((c) => c.date === "1970-01-01T00:01:40+00:00");

  assert.deepEqual(child?.files, ["top.ts"]);
});

test("skips merge commits, matching plain git log --name-only", () => {
  const gitDir = makeGitDir();
  const treeA = fakeSha("ta");
  const treeB = fakeSha("tb");
  const treeMerge = fakeSha("tm");
  const commitA = fakeSha("ca");
  const commitB = fakeSha("cb");
  const commitMerge = fakeSha("cm");

  writeTree(gitDir, treeA, [{ mode: "100644", name: "a.ts", sha: fakeSha("a") }]);
  writeTree(gitDir, treeB, [{ mode: "100644", name: "b.ts", sha: fakeSha("b") }]);
  writeTree(gitDir, treeMerge, [
    { mode: "100644", name: "a.ts", sha: fakeSha("a") },
    { mode: "100644", name: "b.ts", sha: fakeSha("b") },
  ]);
  writeCommit(gitDir, commitA, treeA, [], "Jane Doe <jane@example.com> 0 +0000");
  writeCommit(gitDir, commitB, treeB, [], "Jane Doe <jane@example.com> 0 +0000");
  writeCommit(gitDir, commitMerge, treeMerge, [commitA, commitB], "Jane Doe <jane@example.com> 200 +0000");
  setHead(gitDir, commitMerge);

  const commits = readCommitsFromGitDir(gitDir);

  assert.equal(commits.length, 2);
  assert.ok(!commits.some((c) => c.date === "1970-01-01T00:03:20+00:00"));
});

test("resolves HEAD through packed-refs when the loose ref file is gone", () => {
  const gitDir = makeGitDir();
  const tree = fakeSha("t1");
  const commit = fakeSha("c1");

  writeTree(gitDir, tree, [{ mode: "100644", name: "a.ts", sha: fakeSha("a") }]);
  writeCommit(gitDir, commit, tree, [], "Jane Doe <jane@example.com> 0 +0000");
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitDir, "packed-refs"), `${commit} refs/heads/main\n`);

  const commits = readCommitsFromGitDir(gitDir);

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files, ["a.ts"]);
});

test("raises a clear error when an object has been packed rather than left loose", () => {
  const gitDir = makeGitDir();
  const missingCommit = fakeSha("cf");
  setHead(gitDir, missingCommit);

  assert.throws(() => readCommitsFromGitDir(gitDir), /isn't stored as a loose object/);
});
