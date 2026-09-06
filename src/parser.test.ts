import { test } from "node:test";
import assert from "node:assert/strict";
import { iterateCommits } from "./parser.js";

test("parses a single commit with several files", () => {
  const text = ["commit:abc123 2024-01-15T10:00:00-05:00", "a.ts", "b.ts", ""].join("\n");

  const commits = Array.from(iterateCommits(text));

  assert.equal(commits.length, 1);
  assert.equal(commits[0].date, "2024-01-15T10:00:00-05:00");
  assert.deepEqual(commits[0].files, ["a.ts", "b.ts"]);
});

test("splits multiple commits on the commit: marker", () => {
  const text = [
    "commit:abc123 2024-01-15T10:00:00-05:00",
    "a.ts",
    "b.ts",
    "",
    "commit:def456 2024-01-16T11:00:00-05:00",
    "c.ts",
    "",
  ].join("\n");

  const commits = Array.from(iterateCommits(text));

  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].files, ["a.ts", "b.ts"]);
  assert.deepEqual(commits[1].files, ["c.ts"]);
});

test("yields the final commit even without a trailing blank line", () => {
  const text = "commit:abc123 2024-01-15T10:00:00-05:00\na.ts\nb.ts";

  const commits = Array.from(iterateCommits(text));

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files, ["a.ts", "b.ts"]);
});

test("skips commits that touched no files", () => {
  const text = [
    "commit:abc123 2024-01-15T10:00:00-05:00",
    "",
    "commit:def456 2024-01-16T11:00:00-05:00",
    "c.ts",
    "",
  ].join("\n");

  const commits = Array.from(iterateCommits(text));

  assert.equal(commits.length, 1);
  assert.equal(commits[0].date, "2024-01-16T11:00:00-05:00");
});

test("handles a marker line with no date", () => {
  const text = ["commit:abc123", "a.ts", ""].join("\n");

  const commits = Array.from(iterateCommits(text));

  assert.equal(commits.length, 1);
  assert.equal(commits[0].date, "");
});

test("yields nothing for empty input", () => {
  const commits = Array.from(iterateCommits(""));

  assert.equal(commits.length, 0);
});
