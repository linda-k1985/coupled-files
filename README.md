# coupled-files

`git blame` tells you who last touched a line. It doesn't tell you that
`billing/invoice.ts` and `email/receipt-template.ts` almost always change
together, even though nothing in either file imports the other. That kind
of coupling only shows up in the history of commits, not in the code
itself, and it's exactly the thing you want to know before you refactor
one of those files and get surprised by the other one breaking.

`coupled-files` answers one question: given a git history, which pairs of
files were touched in the same commit most often?

## how it works

The tool doesn't call git itself. You produce the log text (from a live
repo, from CI, from an archive, whatever) and feed it to the tool over
stdin or as a file argument. It expects the shape produced by:

```
git log --name-only --pretty=format:'commit:%H %aI'
```

That prints a `commit:<hash> <author-date>` marker line before the list of
files touched in each commit, with a blank line separating commits. The
date is `%aI`, git's ISO 8601 author date, which `--since`/`--until` rely
on. `coupled-files` counts, for every commit, every pair of distinct files
it touched, and reports the pairs with the highest counts.

## usage

Piped straight from git:

```
git log --name-only --pretty=format:'commit:%H %aI' | coupled-files
```

Or from a saved log, useful if you want to snapshot history from a
machine that doesn't have the tool installed:

```
git log --name-only --pretty=format:'commit:%H %aI' > history.log
coupled-files history.log
```

Output is tab-separated: count, then the two file paths, sorted by count
descending.

```
41	src/billing/invoice.ts	src/email/receipt-template.ts
17	src/api/routes.ts	src/api/schema.ts
9	README.md	CHANGELOG.md
```

## options

- `--min=N` only show pairs that changed together at least N times
  (default 2)
- `--top=N` show at most N pairs (default 20)
- `--max-files=N` skip commits that touch more than N files (default 100).
  Mass renames and formatter runs touch hundreds of unrelated files and
  turn every one of them into a pair, which drowns out real coupling.
  Skipped commits are counted and reported on stderr.
- `--json` print `{"pairs": [...], "skipped": N}` on stdout instead of
  tab-separated lines. Each entry in `pairs` is `{"count": N, "files": [a, b]}`.
  The skipped-commit count is repeated here for scripts that don't want to
  parse stderr; the plain-text stderr warning still prints either way.
- `--since=DATE` / `--until=DATE` only count commits with an author date on
  or after / on or before `DATE`. `DATE` is anything `Date` in JavaScript
  can parse, so plain `2024-01-15` and full ISO timestamps both work. An
  unparseable date is reported on stderr and exits with status 1.
- `--git-dir=PATH` read commits straight from a repository's object
  database instead of stdin or a saved log file. `PATH` can be a working
  tree (containing a `.git` directory) or a bare/`.git` directory itself.
  This walks every commit reachable from `HEAD`, diffs each one against
  its first parent to find changed files (merge commits are skipped, same
  as plain `git log --name-only`), and needs no `git log` step first:

  ```
  coupled-files --git-dir=.
  ```

  It only understands loose objects. Once a repo has been packed — after
  `git gc`, or in most clones — its objects live in `.git/objects/pack/`
  instead, and this option fails with an error pointing back at the
  `git log` pipe as a fallback. Packfile support isn't implemented yet.

## building

There are no runtime dependencies, but you need a TypeScript compiler to
build from source:

```
tsc
node dist/index.js
```

Tests use Node's built-in test runner, so there's nothing extra to install:

```
npm test
```

## limitations right now

`--git-dir` only reads loose objects, so it won't work against a packed
repository (see above). Renames are always counted as a delete of the old
path plus an add of the new one, since neither the piped `git log` input
nor `--git-dir`'s tree diffing does rename detection.
