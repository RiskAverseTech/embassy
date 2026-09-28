/**
 * The ledger: a hash-chained, append-only record of everything that crossed
 * the boundary.
 *
 * What it guarantees, and what it does not:
 *
 * - Every entry carries the hash of the entry before it. Editing, deleting,
 *   reordering, or truncating past entries breaks the chain, and
 *   `verifyChain()` reports exactly where.
 * - A chain can be rewritten wholesale by anyone with write access to the
 *   file. What stops that from being silent is the ANCHOR: every delivered
 *   message carries the chain head (sequence + hash) as it stood at that
 *   moment. The anchors live on the other side of the boundary, in the
 *   delivered posts, where the operator cannot edit them. To rewrite history
 *   undetectably you would have to rewrite the other civilization's copy.
 * - Optionally, entries are HMAC-signed with EMBASSY_LEDGER_KEY. With a key
 *   held off the delivery host, a rewritten chain also fails signature
 *   verification. Without a key, tamper-EVIDENT (via anchors); with one,
 *   tamper-RESISTANT as well.
 *
 * - The chain alone cannot detect ROLLBACK: dropping the last N entries leaves
 *   a shorter chain that is internally consistent. Two things catch that:
 *   a sidecar head file (`ledger.head`) written on every append, which
 *   `verifyChain()` compares against by default; and the anchors above,
 *   which `verifyChain({ expect })` compares against when you hand it one
 *   copied from a delivered message. The sidecar is on the same host as the
 *   ledger, so it defends against accidents and casual tampering; the
 *   anchors defend against the operator.
 *
 * The ledger is also what enforces rate limits, so a restart does not reset
 * the Embassy's budget. Truncating or deleting the ledger to refill it is
 * visible: the head file, or any anchor, will disagree.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { RateLimit } from "./charter";

export const SCHEMA = 2;

export interface CrossingEntry {
  schema: typeof SCHEMA;
  kind: "crossing";
  seq: number;
  prev: string;
  id: string;
  at: string;
  from: string[];
  to: string;
  transform: string;
  model: string;
  promptVersion: string;
  soulHash: string;
  /** Lines removed from an LLM transform's output by the footer-impostor filter. Always 0 for verbatim. */
  strippedLines: number;
  sources: string[];
  title: string;
  source: string;
  sourceHash: string;
  rendered: string;
  body: string;
  bodyHash: string;
  anchor: { seq: number; hash: string };
  hash: string;
}

export interface DeliveryEntry {
  schema: typeof SCHEMA;
  kind: "delivery";
  seq: number;
  prev: string;
  crossing: string;
  at: string;
  ok: boolean;
  ref: string | null;
  error: string | null;
  hash: string;
}

export interface CharterEntry {
  schema: typeof SCHEMA;
  kind: "charter";
  seq: number;
  prev: string;
  at: string;
  charterHash: string;
  soulHash: string;
  edges: string[];
  hash: string;
}

export type Entry = CrossingEntry | DeliveryEntry | CharterEntry;

export interface ChainReport {
  ok: boolean;
  entries: number;
  head: { seq: number; hash: string };
  corruptLines: number[];
  brokenAt: number | null;
  reason: string | null;
  signed: boolean;
  /** What the chain was compared against: the sidecar head file, an explicit anchor, or nothing. */
  comparedTo: "anchor" | "head-file" | "none";
  /**
   * How strong the rollback guarantee is. `ok` means the chain is internally
   * consistent and matches what it was compared to; `assurance` says whether
   * that comparison could have been forged by whoever controls the host.
   */
  assurance: "anchored" | "signed" | "sidecar-unsigned" | "none";
}

export const LEDGER_DIR = path.join(os.homedir(), ".config", "embassy");
export const LEDGER_FILE = path.join(LEDGER_DIR, "ledger.jsonl");
export const GENESIS = "0".repeat(64);
const LOCK_STALE_MS = 120_000;

export class LedgerLocked extends Error {
  constructor(file: string) {
    super(`another Embassy process holds ${file} — try again shortly`);
    this.name = "LedgerLocked";
  }
}

export function sha(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function canonical(entry: Omit<Entry, "hash">): string {
  // Stable key order so the hash does not depend on insertion order.
  const sorted = Object.keys(entry).sort().reduce((acc, k) => {
    acc[k] = (entry as any)[k];
    return acc;
  }, {} as Record<string, unknown>);
  return JSON.stringify(sorted);
}

export function crossingId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export class Ledger {
  readonly file: string;
  readonly #key: string | null;

  constructor(file: string = LEDGER_FILE, key: string | null = process.env.EMBASSY_LEDGER_KEY ?? null) {
    this.file = file;
    this.#key = key;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  get signed(): boolean {
    return this.#key !== null;
  }

  get headFile(): string {
    return this.file.replace(/\.jsonl$/, "") + ".head";
  }

  /** The head as last written to the sidecar, signed with the key when one is set. */
  storedHead(): { seq: number; hash: string; sig: string } | null {
    if (!fs.existsSync(this.headFile)) return null;
    try { return JSON.parse(fs.readFileSync(this.headFile, "utf-8")); } catch { return null; }
  }

  #writeHead(head: { seq: number; hash: string }): void {
    const sig = this.#digest(`${head.seq}:${head.hash}`);
    const tmp = this.headFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ...head, sig }), "utf-8");
    fs.renameSync(tmp, this.headFile); // atomic replace
  }

  /**
   * Cross-process mutex. `wx` is an atomic create. A stale lock is reclaimed
   * by an atomic rename, so two processes that both judge it stale cannot
   * both win: only the one whose rename succeeds proceeds to re-acquire.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = this.file + ".lock";
    let held = false;
    for (let attempt = 0; attempt < 5 && !held; attempt++) {
      try {
        fs.writeFileSync(lock, `${process.pid}:${crypto.randomBytes(4).toString("hex")}`, { flag: "wx" });
        held = true;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age > LOCK_STALE_MS) {
          const graveyard = `${lock}.stale.${process.pid}.${Date.now()}`;
          try { fs.renameSync(lock, graveyard); fs.rmSync(graveyard, { force: true }); } catch { /* someone else reclaimed it */ }
          continue;
        }
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    if (!held) throw new LedgerLocked(lock);
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  #digest(text: string): string {
    return this.#key
      ? crypto.createHmac("sha256", this.#key).update(text, "utf8").digest("hex")
      : sha(text);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Parse every line; corrupt lines are reported, not fatal. */
  #read(): { entries: Entry[]; corrupt: number[] } {
    if (!fs.existsSync(this.file)) return { entries: [], corrupt: [] };
    const entries: Entry[] = [];
    const corrupt: number[] = [];
    const lines = fs.readFileSync(this.file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (typeof e?.seq !== "number" || typeof e?.hash !== "string") throw new Error("shape");
        entries.push(e as Entry);
      } catch {
        corrupt.push(i + 1);
      }
    }
    return { entries, corrupt };
  }

  all(): Entry[] {
    return this.#read().entries;
  }

  crossings(): CrossingEntry[] {
    return this.all().filter((e): e is CrossingEntry => e.kind === "crossing");
  }

  deliveries(): DeliveryEntry[] {
    return this.all().filter((e): e is DeliveryEntry => e.kind === "delivery");
  }

  recent(n: number = 20): CrossingEntry[] {
    return this.crossings().slice(-n).reverse();
  }

  find(id: string): CrossingEntry | null {
    return this.crossings().find((c) => c.id === id) ?? null;
  }

  /** The successful delivery for a crossing, if any. */
  deliveryOf(id: string): DeliveryEntry | null {
    return this.deliveries().filter((d) => d.crossing === id && d.ok).pop() ?? null;
  }

  head(): { seq: number; hash: string } {
    const entries = this.all();
    if (!entries.length) return { seq: 0, hash: GENESIS };
    const last = entries[entries.length - 1];
    return { seq: last.seq, hash: last.hash };
  }

  /** How many crossings landed on this edge inside the rate window. Counts attempts, not deliveries: conservative. */
  countWithin(edgeId: string, rate: RateLimit): number {
    const windowMs = rate.per === "hour" ? 3_600_000 : 86_400_000;
    const cutoff = Date.now() - windowMs;
    return this.crossings().filter((c) => c.to === edgeId && Date.parse(c.at) >= cutoff).length;
  }

  /** Source ids that have been delivered, so a failed delivery is retried next sweep rather than lost. */
  deliveredSources(): Set<string> {
    const delivered = new Set(this.deliveries().filter((d) => d.ok).map((d) => d.crossing));
    const out = new Set<string>();
    for (const c of this.crossings()) {
      if (delivered.has(c.id)) for (const s of c.sources) out.add(s);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  #append<T extends Entry>(partial: Omit<T, "seq" | "prev" | "hash" | "schema">): T {
    const head = this.head();
    const unsigned = { ...partial, schema: SCHEMA, seq: head.seq + 1, prev: head.hash } as Omit<T, "hash">;
    const entry = { ...unsigned, hash: this.#digest(canonical(unsigned)) } as T;
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf-8");
    this.#writeHead({ seq: entry.seq, hash: entry.hash });
    return entry;
  }

  recordCrossing(fields: {
    id: string;
    from: string[];
    to: string;
    transform: string;
    model: string;
    promptVersion: string;
    soulHash: string;
    strippedLines: number;
    sources: string[];
    title: string;
    source: string;
    rendered: string;
    body: string;
  }): CrossingEntry {
    return this.#append<CrossingEntry>({
      kind: "crossing",
      at: new Date().toISOString(),
      anchor: this.head(),
      sourceHash: sha(fields.source),
      bodyHash: sha(fields.body),
      ...fields,
    });
  }

  recordDelivery(crossing: string, result: { ok: true; ref: string } | { ok: false; error: string }): DeliveryEntry {
    return this.#append<DeliveryEntry>({
      kind: "delivery",
      crossing,
      at: new Date().toISOString(),
      ok: result.ok,
      ref: result.ok ? result.ref : null,
      error: result.ok ? null : result.error,
    });
  }

  recordCharter(charterHash: string, soulHash: string, edges: string[]): CharterEntry {
    return this.#append<CharterEntry>({
      kind: "charter",
      at: new Date().toISOString(),
      charterHash,
      soulHash,
      edges,
    });
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /** One crossing: does its stored content still match its hashes and its chain link? */
  verify(id: string): { ok: boolean; crossing: CrossingEntry | null; reason: string | null } {
    const crossing = this.find(id);
    if (!crossing) return { ok: false, crossing: null, reason: "no such crossing" };
    if (sha(crossing.source) !== crossing.sourceHash) return { ok: false, crossing, reason: "source hash mismatch" };
    if (sha(crossing.body) !== crossing.bodyHash) return { ok: false, crossing, reason: "body hash mismatch" };
    const { hash, ...rest } = crossing;
    if (this.#digest(canonical(rest)) !== hash) return { ok: false, crossing, reason: "entry hash mismatch" };
    return { ok: true, crossing, reason: null };
  }

  /**
   * The whole chain: contiguous sequence, each prev matches, each hash
   * matches — and the resulting head matches what it is compared against.
   * Pass `expect` with an anchor copied from a delivered message (the
   * `ledger #N hash` in its footer; a 12-char hash prefix is enough) to check
   * against something the operator's host does not control. Without it, the
   * sidecar head file is used, which catches truncation and deletion by
   * anyone who did not also rewrite the sidecar.
   */
  verifyChain(opts: { expect?: { seq: number; hash: string } } = {}): ChainReport {
    const { entries, corrupt } = this.#read();
    const report: ChainReport = {
      ok: true,
      entries: entries.length,
      head: { seq: 0, hash: GENESIS },
      corruptLines: corrupt,
      brokenAt: null,
      reason: null,
      signed: this.signed,
      comparedTo: "none",
      assurance: "none",
    };

    if (corrupt.length) {
      report.ok = false;
      report.brokenAt = corrupt[0];
      report.reason = `unparseable line ${corrupt[0]}`;
    }

    let prev = GENESIS;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const expectedSeq = i + 1;
      const { hash, ...rest } = e;
      let reason: string | null = null;
      if (e.seq !== expectedSeq) reason = `seq ${e.seq} at position ${expectedSeq} (gap or reorder)`;
      else if (e.prev !== prev) reason = `prev link broken at seq ${e.seq}`;
      else if (this.#digest(canonical(rest)) !== hash) reason = `hash mismatch at seq ${e.seq}${this.signed ? " (or wrong key)" : ""}`;
      if (reason && report.ok) {
        report.ok = false;
        report.brokenAt = e.seq;
        report.reason = reason;
      }
      prev = e.hash;
    }

    report.head = entries.length ? { seq: entries[entries.length - 1].seq, hash: prev } : report.head;

    // Rollback detection: a shorter chain is internally consistent, so the
    // head must be compared to something outside the chain.
    const expect = opts.expect ?? null;
    const stored = expect ? null : this.storedHead();
    if (expect) {
      report.comparedTo = "anchor";
      report.assurance = "anchored";
      const matches = report.head.seq === expect.seq && report.head.hash.startsWith(expect.hash);
      // An anchor from an older delivery legitimately precedes the head; it must appear IN the chain.
      const inChain = entries.some((e) => e.seq === expect.seq && e.hash.startsWith(expect.hash));
      if (!matches && !inChain && report.ok) {
        report.ok = false;
        report.reason = `anchor #${expect.seq} ${expect.hash.slice(0, 12)} is not in this chain — rolled back or rewritten`;
      }
    } else if (stored) {
      report.comparedTo = "head-file";
      report.assurance = this.signed ? "signed" : "sidecar-unsigned";
      const sigOk = stored.sig === this.#digest(`${stored.seq}:${stored.hash}`);
      if (!sigOk && report.ok) {
        report.ok = false;
        report.reason = `head file signature invalid${this.signed ? " (or wrong key)" : ""}`;
      } else if ((stored.seq !== report.head.seq || stored.hash !== report.head.hash) && report.ok) {
        report.ok = false;
        report.reason = `chain head #${report.head.seq} does not match recorded head #${stored.seq} — truncated or rolled back`;
      }
    } else if (entries.length) {
      report.comparedTo = "none";
      if (report.ok) {
        report.ok = false;
        report.reason = "no head file — chain is internally consistent but rollback cannot be ruled out; verify against a delivered anchor";
      }
    }
    return report;
  }

  /** Latest recorded charter entry, so a changed charter or constitution is noticed on open. */
  lastCharter(): CharterEntry | null {
    return this.all().filter((e): e is CharterEntry => e.kind === "charter").pop() ?? null;
  }
}
