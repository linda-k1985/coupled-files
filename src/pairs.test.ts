import { test } from "node:test";
import assert from "node:assert/strict";
import { countPairs } from "./pairs.js";

function log(...commits: Array<{ date: string; files: string[] }>): string {
  return commits
    .map((commit) => [`commit:${Math.random().toString(16).slice(2)} ${commit.date}`, ...commit.files, ""].join("\n"))
    .join("\n");
}

test("counts each distinct pair of files touched together once per commit", () => {
  const text = log({ date: "2024-01-01T00:00:00Z", files: ["a.ts", "b.ts", "c.ts"] });

  const { counts, skipped } = countPairs(text, 100, null, null);

  assert.equal(skipped, 0);
  assert.equal(counts.get("a.ts b.ts"), 1);
  assert.equal(counts.get("a.ts c.ts"), 1);
  assert.equal(counts.get("b.ts c.ts"), 1);
});

test("accumulates counts across commits", () => {
  const text = log(
    { date: "2024-01-01T00:00:00Z", files: ["a.ts", "b.ts"] },
    { date: "2024-01-02T00:00:00Z", files: ["a.ts", "b.ts"] },
    { date: "2024-01-03T00:00:00Z", files: ["a.ts", "c.ts"] },
  );

  const { counts } = countPairs(text, 100, null, null);

  assert.equal(counts.get("a.ts b.ts"), 2);
  assert.equal(counts.get("a.ts c.ts"), 1);
});

test("ignores duplicate file entries within a single commit", () => {
  const text = log({ date: "2024-01-01T00:00:00Z", files: ["a.ts", "a.ts", "b.ts"] });

  const { counts } = countPairs(text, 100, null, null);

  assert.equal(counts.get("a.ts b.ts"), 1);
  assert.equal(counts.size, 1);
});

test("skips commits over the max-files limit and counts them", () => {
  const text = log(
    { date: "2024-01-01T00:00:00Z", files: ["a.ts", "b.ts", "c.ts"] },
    { date: "2024-01-02T00:00:00Z", files: ["x.ts", "y.ts"] },
  );

  const { counts, skipped } = countPairs(text, 2, null, null);

  assert.equal(skipped, 1);
  assert.equal(counts.get("x.ts y.ts"), 1);
  assert.equal(counts.has("a.ts b.ts"), false);
});

test("filters out commits before the since date", () => {
  const text = log(
    { date: "2024-01-01T00:00:00Z", files: ["a.ts", "b.ts"] },
    { date: "2024-06-01T00:00:00Z", files: ["a.ts", "b.ts"] },
  );

  const { counts } = countPairs(text, 100, new Date("2024-03-01T00:00:00Z"), null);

  assert.equal(counts.get("a.ts b.ts"), 1);
});

test("filters out commits after the until date", () => {
  const text = log(
    { date: "2024-01-01T00:00:00Z", files: ["a.ts", "b.ts"] },
    { date: "2024-06-01T00:00:00Z", files: ["a.ts", "b.ts"] },
  );

  const { counts } = countPairs(text, 100, null, new Date("2024-03-01T00:00:00Z"));

  assert.equal(counts.get("a.ts b.ts"), 1);
});

test("a commit touching a single file produces no pairs", () => {
  const text = log({ date: "2024-01-01T00:00:00Z", files: ["a.ts"] });

  const { counts } = countPairs(text, 100, null, null);

  assert.equal(counts.size, 0);
});
