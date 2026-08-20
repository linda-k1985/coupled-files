// Expects the output of a git log invocation shaped like:
//
//   git log --name-only --pretty=format:'commit:%H'
//
// which prints a marker line for each commit followed by the paths touched
// in that commit, then a blank line before the next commit. We don't shell
// out to git ourselves — the caller decides how to produce that text and
// pipes it in or saves it to a file.

export function* iterateCommits(text: string): Generator<string[]> {
  let current: string[] | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("commit:")) {
      if (current && current.length > 0) {
        yield current;
      }
      current = [];
      continue;
    }

    if (line.length > 0 && current !== null) {
      current.push(line);
    }
  }

  if (current && current.length > 0) {
    yield current;
  }
}
