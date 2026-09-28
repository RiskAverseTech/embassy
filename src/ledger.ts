/**
 * The ledger: an append-only record of everything that crossed the boundary.
 *
 * v1 of the Embassy promised honest brokerage in SOUL.md. A promise in a
 * markdown file is not a mechanism. The ledger is the mechanism: every
 * crossing stores the source text and the rendered text side by side, so
 * either side can check what was said in their name and how it was rendered
 * for the other.
 *
 * The ledger is also what enforces rate limits, so a restart does not reset
 * the Embassy's budget.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { RateLimit } from "./charter";

export interface Crossing {
  id: string;
  at: string;
  from: string;
  to: string;
  transform: string;
  source: string;
  sourceHash: string;
  rendered: string;
  renderedHash: string;
  delivered: string | null;
}

export const LEDGER_DIR = path.join(os.homedir(), ".config", "embassy");
export const LEDGER_FILE = path.join(LEDGER_DIR, "ledger.jsonl");

function sha(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function crossingId(): string {
  return crypto.randomBytes(5).toString("hex");
}

export class Ledger {
  readonly file: string;

  constructor(file: string = LEDGER_FILE) {
    this.file = file;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  record(entry: {
    from: string;
    to: string;
    transform: string;
    source: string;
    rendered: string;
    delivered?: string | null;
  }): Crossing {
    const crossing: Crossing = {
      id: crossingId(),
      at: new Date().toISOString(),
      from: entry.from,
      to: entry.to,
      transform: entry.transform,
      source: entry.source,
      sourceHash: sha(entry.source),
      rendered: entry.rendered,
      renderedHash: sha(entry.rendered),
      delivered: entry.delivered ?? null,
    };
    fs.appendFileSync(this.file, JSON.stringify(crossing) + "\n", "utf-8");
    return crossing;
  }

  all(): Crossing[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Crossing);
  }

  recent(n: number = 20): Crossing[] {
    return this.all().slice(-n).reverse();
  }

  find(id: string): Crossing | null {
    return this.all().find((c) => c.id === id) ?? null;
  }

  /** How many crossings landed on this edge inside the rate window. */
  countWithin(edgeId: string, rate: RateLimit): number {
    const windowMs = rate.per === "hour" ? 3_600_000 : 86_400_000;
    const cutoff = Date.now() - windowMs;
    return this.all().filter(
      (c) => c.to === edgeId && Date.parse(c.at) >= cutoff
    ).length;
  }

  /**
   * Confirm that a rendered message still matches what the ledger recorded.
   * This is what makes the ledger an audit trail rather than a log file.
   */
  verify(id: string): { ok: boolean; crossing: Crossing | null; reason?: string } {
    const crossing = this.find(id);
    if (!crossing) return { ok: false, crossing: null, reason: "no such crossing" };
    if (sha(crossing.source) !== crossing.sourceHash) {
      return { ok: false, crossing, reason: "source hash mismatch" };
    }
    if (sha(crossing.rendered) !== crossing.renderedHash) {
      return { ok: false, crossing, reason: "rendered hash mismatch" };
    }
    return { ok: true, crossing };
  }
}
