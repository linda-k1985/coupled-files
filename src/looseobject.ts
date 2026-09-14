// Reads a single object stored the simple way: zlib-deflated under
// .git/objects/<first 2 hex chars>/<remaining 38 hex chars>. This is how
// every object starts out (each `git commit`, `git add`, etc. writes one),
// before a `git gc` or a clone packs them away into objects/pack/*.pack.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export interface RawObject {
  type: string;
  content: Buffer;
}

export function readLooseObject(gitDir: string, sha: string): RawObject | null {
  const path = join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
  if (!existsSync(path)) return null;

  const raw = inflateSync(readFileSync(path));
  const nullIndex = raw.indexOf(0);
  const type = raw.subarray(0, nullIndex).toString("ascii").split(" ")[0];
  return { type, content: raw.subarray(nullIndex + 1) };
}
