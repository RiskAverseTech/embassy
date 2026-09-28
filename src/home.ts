/**
 * Locate the directory holding CHARTER.md and SOUL.md. Honors EMBASSY_HOME,
 * then walks up from this file (so a compiled dist/ still finds the repo
 * root), then the working directory.
 */

import fs from "fs";
import path from "path";

export class HomeNotFound extends Error {
  constructor() {
    super("cannot find CHARTER.md — set EMBASSY_HOME or run from the repo");
    this.name = "HomeNotFound";
  }
}

export function findHome(): string {
  // An explicit EMBASSY_HOME is authoritative: if it is wrong, say so rather
  // than silently running some other Embassy found by walking up.
  if (process.env.EMBASSY_HOME) {
    const explicit = path.resolve(process.env.EMBASSY_HOME);
    if (fs.existsSync(path.join(explicit, "CHARTER.md"))) return explicit;
    throw new HomeNotFound();
  }
  const candidates = [__dirname, process.cwd()];
  for (const start of candidates) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, "CHARTER.md"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new HomeNotFound();
}
