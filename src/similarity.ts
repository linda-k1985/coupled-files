// Content similarity between two blobs, used to recognise a file that was
// moved and lightly edited in the same commit. The score is the share of
// bytes, counted line by line, that both versions have in common, which is
// close to what git's own rename detection does and cheap enough to run on
// every unmatched delete/add pair.

export type LineProfile = Map<string, number>;

export function profileLines(content: Buffer): LineProfile {
  const profile: LineProfile = new Map();
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf(0x0a, start);
    const end = newline === -1 ? content.length : newline + 1;
    // latin1 keeps a one-to-one mapping between bytes and characters, so
    // binary content doesn't get mangled by utf8 decoding and the string
    // length is the byte length.
    const line = content.toString("latin1", start, end);
    profile.set(line, (profile.get(line) ?? 0) + 1);
    start = end;
  }
  return profile;
}

function totalBytes(profile: LineProfile): number {
  let total = 0;
  for (const [line, count] of profile) total += line.length * count;
  return total;
}

// Returns a value between 0 and 1. Two empty blobs are identical; an empty
// blob against a non-empty one shares nothing.
export function similarity(a: LineProfile, b: LineProfile): number {
  const sizeA = totalBytes(a);
  const sizeB = totalBytes(b);
  const largest = Math.max(sizeA, sizeB);
  if (largest === 0) return 1;

  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [line, count] of smaller) {
    const other = larger.get(line);
    if (other) shared += line.length * Math.min(count, other);
  }
  return shared / largest;
}
