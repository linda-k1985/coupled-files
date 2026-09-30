import { test } from "node:test";
import assert from "node:assert/strict";
import { profileLines, similarity } from "./similarity.js";

function score(a: string, b: string): number {
  return similarity(profileLines(Buffer.from(a)), profileLines(Buffer.from(b)));
}

test("identical content scores 1", () => {
  assert.equal(score("one\ntwo\nthree\n", "one\ntwo\nthree\n"), 1);
});

test("content with no lines in common scores 0", () => {
  assert.equal(score("one\ntwo\n", "three\nfour\n"), 0);
});

test("one changed line out of four scores the share of bytes kept", () => {
  // 3 of the 4 equally sized lines survive.
  assert.equal(score("aaa\nbbb\nccc\nddd\n", "aaa\nbbb\nccc\nxxx\n"), 0.75);
});

test("a large addition lowers the score relative to the bigger file", () => {
  assert.equal(score("aaa\n", "aaa\nbbb\nccc\nddd\n"), 0.25);
});

test("repeated lines are only matched as many times as both sides have them", () => {
  assert.equal(score("x\nx\nx\nx\n", "x\nx\n"), 0.5);
});

test("a final line without a newline only matches the same unterminated line", () => {
  assert.equal(score("a\nb", "a\nb\n") < 1, true);
  assert.equal(score("a\nb", "a\nb"), 1);
});

test("two empty blobs are identical and empty against non-empty shares nothing", () => {
  assert.equal(score("", ""), 1);
  assert.equal(score("", "a\n"), 0);
});
