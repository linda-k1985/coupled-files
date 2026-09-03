// Expects the output of a git log invocation shaped like:
//
//   git log --name-only --pretty=format:'commit:%H %aI'
//
// which prints a marker line for each commit (hash then author date in
// ISO 8601, so it sorts and parses without ambiguity) followed by the
// paths touched in that commit, then a blank line before the next commit.
// We don't shell out to git ourselves — the caller decides how to produce
// that text and pipes it in or saves it to a file.

export interface Commit {
  date: string;
  files: string[];
}

export function* iterateCommits(text: string): Generator<Commit> {
  let current: Commit | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("commit:")) {
      if (current && current.files.length > 0) {
        yield current;
      }
      const rest = line.slice("commit:".length).trim();
      const spaceIndex = rest.indexOf(" ");
      const date = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1).trim();
      current = { date, files: [] };
      continue;
    }

    if (line.length > 0 && current !== null) {
      current.files.push(line);
    }
  }

  if (current && current.files.length > 0) {
    yield current;
  }
}
