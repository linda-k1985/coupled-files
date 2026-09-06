import { iterateCommits } from "./parser.js";

export interface PairCounts {
  counts: Map<string, number>;
  skipped: number;
}

export function countPairs(
  text: string,
  maxFiles: number,
  since: Date | null,
  until: Date | null,
): PairCounts {
  const counts = new Map<string, number>();
  let skipped = 0;

  for (const commit of iterateCommits(text)) {
    if (since || until) {
      const commitDate = new Date(commit.date);
      if (since && commitDate < since) continue;
      if (until && commitDate > until) continue;
    }

    const unique = Array.from(new Set(commit.files)).sort();

    if (unique.length > maxFiles) {
      skipped++;
      continue;
    }

    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]} ${unique[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  return { counts, skipped };
}
