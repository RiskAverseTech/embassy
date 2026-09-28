/**
 * Per-platform credentials, stored under ~/.config/embassy/credentials/<platform>.json
 * with mode 0600. A platform alias from the charter maps to exactly one file.
 *
 * The v1/v2.0 single `credentials.json` (Moltbook) is read as the `moltbook`
 * platform's credentials if no per-platform file exists, so an existing
 * install keeps working.
 */

import fs from "fs";
import path from "path";
import os from "os";

/** Resolved at call time so a test (or a service) can point HOME elsewhere. */
export function configDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".config", "embassy");
}
const credDir = () => path.join(configDir(), "credentials");
const legacy = () => path.join(configDir(), "credentials.json");

export type Credentials = Record<string, string>;

const PLATFORM = /^[a-z][a-z0-9-]*$/;

function fileFor(platform: string): string {
  if (!PLATFORM.test(platform)) throw new Error(`invalid platform id '${platform}'`);
  return path.join(credDir(), `${platform}.json`);
}

/**
 * `base` is the platform's base URL. The legacy single credentials.json was a
 * Moltbook key; it is offered only to an alias whose base is actually
 * www.moltbook.com, never to an alias that merely calls itself "moltbook".
 */
export function loadCredentials(platform: string, base: string | null = null): Credentials | null {
  const file = fileFor(platform);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  if (platform === "moltbook" && base && new URL(base).hostname === "www.moltbook.com" && fs.existsSync(legacy())) {
    return JSON.parse(fs.readFileSync(legacy(), "utf-8"));
  }
  return null;
}

export function saveCredentials(platform: string, creds: Credentials): string {
  const file = fileFor(platform);
  fs.mkdirSync(credDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return file;
}

export function hasCredentials(platform: string): boolean {
  return loadCredentials(platform) !== null;
}
