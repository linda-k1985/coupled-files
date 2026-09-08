#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { countPairs, countPairsFromCommits, type PairCounts } from "./pairs.js";
import { readCommitsFromGitDir } from "./gitdir.js";

interface Options {
  min: number;
  top: number;
  maxFiles: number;
  json: boolean;
  since: string | null;
  until: string | null;
  gitDir: string | null;
  paths: string[];
}

function parseArgs(argv: string[]): Options {
  // 100 is generous enough for a real change touching several modules
  // but low enough to drop the mass-rename and formatter-run commits
  // that would otherwise flood the pair counts with noise.
  const options: Options = {
    min: 2,
    top: 20,
    maxFiles: 100,
    json: false,
    since: null,
    until: null,
    gitDir: null,
    paths: [],
  };

  for (const arg of argv) {
    if (arg.startsWith("--min=")) {
      options.min = Number(arg.slice("--min=".length));
    } else if (arg.startsWith("--top=")) {
      options.top = Number(arg.slice("--top=".length));
    } else if (arg.startsWith("--max-files=")) {
      options.maxFiles = Number(arg.slice("--max-files=".length));
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--since=")) {
      options.since = arg.slice("--since=".length);
    } else if (arg.startsWith("--until=")) {
      options.until = arg.slice("--until=".length);
    } else if (arg.startsWith("--git-dir=")) {
      options.gitDir = arg.slice("--git-dir=".length);
    } else {
      options.paths.push(arg);
    }
  }

  return options;
}

function parseDateOption(value: string, flag: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    console.error(`invalid date for ${flag}: ${value}`);
    process.exit(1);
  }
  return date;
}

function readInput(paths: string[]): string {
  // No paths means read the whole stream from stdin. fd 0 works whether
  // stdin is piped or redirected from a file, so this covers both cases
  // the tool needs to support without any extra flag.
  if (paths.length === 0) {
    return readFileSync(0, "utf8");
  }
  return paths.map((path) => readFileSync(path, "utf8")).join("\n");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const since = options.since ? parseDateOption(options.since, "--since") : null;
  const until = options.until ? parseDateOption(options.until, "--until") : null;

  let pairCounts: PairCounts;
  if (options.gitDir) {
    try {
      const commits = readCommitsFromGitDir(options.gitDir);
      pairCounts = countPairsFromCommits(commits, options.maxFiles, since, until);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  } else {
    const text = readInput(options.paths);
    pairCounts = countPairs(text, options.maxFiles, since, until);
  }
  const { counts, skipped } = pairCounts;

  const ranked = Array.from(counts.entries())
    .filter(([, count]) => count >= options.min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.top);

  if (skipped > 0) {
    console.error(`skipped ${skipped} commit(s) touching more than ${options.maxFiles} files`);
  }

  if (options.json) {
    const pairs = ranked.map(([key, count]) => {
      const [a, b] = key.split(" ");
      return { count, files: [a, b] };
    });
    console.log(JSON.stringify({ pairs, skipped }));
    return;
  }

  if (ranked.length === 0) {
    console.log(`no file pairs changed together at least ${options.min} times`);
    return;
  }

  for (const [key, count] of ranked) {
    const [a, b] = key.split(" ");
    console.log(`${count}\t${a}\t${b}`);
  }
}

main();
