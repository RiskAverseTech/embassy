/**
 * The charter: the Embassy's single source of truth.
 *
 * Channel access is defined in CHARTER.md and enforced here. Nothing in this
 * module consults a prompt, a model, or an environment variable to decide
 * whether a crossing is allowed.
 *
 * Threat model, stated plainly: the wall stops the relay — and any content
 * flowing through it — from addressing a channel that is not in the charter.
 * It does not stop an operator who edits this file or the charter; no local
 * mechanism can. What it does guarantee is that such an edit is visible in
 * the diff and, once the ledger is anchored, in the audit trail.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TRANSFORMS } from "./transforms";
import { findHome } from "./home";

export type Role = "listen" | "speak" | "report" | "both";
export type Direction = "in" | "out" | "both";

export interface RateLimit {
  count: number;
  per: "hour" | "day";
}

export interface CharterMeta {
  embassy: string;
  version: string;
  scope: string;
  default: "deny";
  provenance: "required" | "optional";
  model: string;
  endpoint: string | null;
}

/**
 * Raised whenever something asks the Embassy to act outside the charter.
 * This is never caught and turned into a warning. A scope violation stops
 * the crossing.
 */
export class ScopeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolation";
  }
}

export class CharterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharterError";
  }
}

const ROLES: Role[] = ["listen", "speak", "report", "both"];
const DIRECTIONS: Direction[] = ["in", "out", "both"];
const CHARTER_MAJOR = 2;
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * An Edge is a capability: holding one is what lets code address a channel.
 *
 * The constructor is private and the class carries a private field, so a
 * plain object literal does not satisfy the type, and `new Edge()` does not
 * compile outside this module. At runtime, adapters additionally check
 * `instanceof Edge`, so a value smuggled past the type system (an `any`, a
 * JSON blob) is still refused. Only `Charter.load()` mints edges.
 */
interface EdgeFields {
  id: string;
  platform: string;
  channel: string;
  role: Role;
  direction: Direction;
  transform: string;
  rate: RateLimit | null;
}

// Module-private. Assigned exactly once, by the static block inside Edge,
// and never exported — so the only code that can mint an Edge is code in
// this file.
let mintEdge!: (fields: EdgeFields) => Edge;
// Runtime guard: `private constructor` is compile-time only. Reflect.construct,
// `new (Edge as any)`, and subclassing all run the real constructor, so the
// constructor itself checks that it was entered through mintEdge.
let minting = false;

export class Edge {
  readonly #minted = true;

  readonly id: string;
  readonly platform: string;
  readonly channel: string;
  readonly role: Role;
  readonly direction: Direction;
  readonly transform: string;
  readonly rate: RateLimit | null;

  static {
    mintEdge = (fields) => {
      minting = true;
      try { return new Edge(fields); } finally { minting = false; }
    };
  }

  private constructor(fields: EdgeFields) {
    if (!minting) throw new ScopeViolation("Edge can only be minted by Charter.load()");
    if (new.target !== Edge) throw new ScopeViolation("Edge cannot be subclassed");
    this.id = fields.id;
    this.platform = fields.platform;
    this.channel = fields.channel;
    this.role = fields.role;
    this.direction = fields.direction;
    this.transform = fields.transform;
    this.rate = fields.rate;
    Object.freeze(this);
  }

  /**
   * True only for values this module constructed. `instanceof` alone can be
   * satisfied by `Object.create(Edge.prototype)`; the private-field brand
   * cannot.
   */
  static is(value: unknown): value is Edge {
    return typeof value === "object" && value !== null && #minted in value;
  }

  get readable(): boolean {
    return (this.role === "listen" || this.role === "both") &&
      (this.direction === "in" || this.direction === "both");
  }

  get writable(): boolean {
    return this.role !== "listen" &&
      (this.direction === "out" || this.direction === "both");
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(text: string): CharterMeta {
  // Anchored to the start of the file. A `---` rule later in the prose is
  // not a candidate, so the metadata cannot be shadowed by a decoy block.
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    throw new CharterError("charter must begin with a --- frontmatter block on line 1");
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    throw new CharterError("charter frontmatter is not terminated");
  }
  const raw = text.slice(4, end);

  const fields: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }

  for (const required of ["embassy", "version", "scope", "default"]) {
    if (!fields[required]) {
      throw new CharterError(`charter frontmatter is missing '${required}'`);
    }
  }

  const major = parseInt(fields.version.split(".")[0], 10);
  if (major !== CHARTER_MAJOR) {
    throw new CharterError(
      `charter version ${fields.version} — this Embassy understands ${CHARTER_MAJOR}.x`
    );
  }

  // An Embassy that defaults to allow is not an Embassy. Refuse to run.
  if (fields.default !== "deny") {
    throw new CharterError(
      `charter 'default' must be 'deny' (got '${fields.default}') — the Embassy refuses to run without a wall`
    );
  }

  const endpoint = fields.endpoint ?? null;
  if (endpoint && !/^https:\/\/[^/\s]+/.test(endpoint)) {
    throw new CharterError(`charter 'endpoint' must be an https:// URL`);
  }

  return {
    embassy: fields.embassy,
    version: fields.version,
    scope: fields.scope,
    default: "deny",
    provenance: fields.provenance === "optional" ? "optional" : "required",
    model: fields.model || DEFAULT_MODEL,
    endpoint,
  };
}

function parseRate(cell: string): RateLimit | null {
  const raw = cell.trim();
  if (!raw || raw === "—" || raw === "-" || raw === "unlimited") return null;

  const match = raw.match(/^(\d+)\s*\/\s*(hour|day)$/i);
  if (!match) {
    throw new CharterError(
      `rate '${raw}' is not understood — use 'N/hour', 'N/day', or '—'`
    );
  }
  return { count: parseInt(match[1], 10), per: match[2].toLowerCase() as "hour" | "day" };
}

/**
 * Only the table directly under the `## Channels` heading is read. Rows in
 * prose, in other sections, or inside fenced code blocks are not edges. A
 * second `## Channels` heading is an error rather than a merge.
 */
function extractChannelsSection(text: string): string {
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Channels\s*$/i.test(lines[i])) {
      count++;
      if (start < 0) start = i + 1;
    } else if (start >= 0 && end === lines.length && /^#{1,6}\s/.test(lines[i])) {
      end = i;
    }
  }

  if (count === 0) throw new CharterError("charter has no '## Channels' section");
  if (count > 1) throw new CharterError("charter has more than one '## Channels' section");

  // A comment opened inside a table row could splice rows together. Refuse.
  for (const line of lines.slice(start, end)) {
    if (line.trim().startsWith("|") && /<!--|-->/.test(line)) {
      throw new CharterError(`HTML comment markers are not allowed inside a channels row: ${line.trim()}`);
    }
  }
  // Strip fenced code and HTML comments from the section so an example row —
  // or a row hidden from rendered view inside <!-- --> — is not an edge.
  const section = lines.slice(start, end).join("\n").replace(/<!--[\s\S]*?-->/g, "");
  const kept: string[] = [];
  let fenced = false;
  for (const line of section.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) kept.push(line);
  }
  return kept.join("\n");
}

function parseTable(section: string): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let headerSeen = false;

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (headerSeen && trimmed) break; // any other content ends the table
      continue;
    }

    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());

    if (!headerSeen) {
      const header = cells.map((c) => c.toLowerCase());
      const expected = ["id", "platform", "channel", "role", "direction", "transform", "rate"];
      if (header.join(",") !== expected.join(",")) {
        throw new CharterError(
          `channels table header must be exactly: ${expected.join(" | ")}`
        );
      }
      headerSeen = true;
      continue;
    }

    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator

    if (cells.length !== 7) {
      throw new CharterError(`channels row has ${cells.length} cells, expected 7: ${trimmed}`);
    }

    const [id, platform, channel, role, direction, transform, rate] = cells;

    if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/.test(id)) {
      throw new CharterError(`edge id '${id}' must be dotted lowercase (e.g. agent.hot)`);
    }
    if (!ROLES.includes(role as Role)) {
      throw new CharterError(`edge '${id}' has role '${role}' — must be one of ${ROLES.join(", ")}`);
    }
    if (!DIRECTIONS.includes(direction as Direction)) {
      throw new CharterError(`edge '${id}' has direction '${direction}' — must be one of ${DIRECTIONS.join(", ")}`);
    }
    if (!TRANSFORMS[transform]) {
      throw new CharterError(
        `edge '${id}' declares transform '${transform}', which is not registered — known: ${Object.keys(TRANSFORMS).join(", ")}`
      );
    }
    if (seen.has(id)) throw new CharterError(`edge '${id}' is declared twice`);
    seen.add(id);

    edges.push(
      mintEdge({
        id,
        platform,
        channel,
        role: role as Role,
        direction: direction as Direction,
        transform,
        rate: parseRate(rate),
      })
    );
  }

  if (!headerSeen) throw new CharterError("'## Channels' section contains no table");
  if (!edges.length) throw new CharterError("charter declares no channels");
  if (!edges.some((e) => e.readable)) throw new CharterError("charter has no readable edge — nothing can come in");
  if (!edges.some((e) => e.writable)) throw new CharterError("charter has no writable edge — nothing can go out");

  return edges;
}

// ---------------------------------------------------------------------------
// Charter
// ---------------------------------------------------------------------------

export class Charter {
  readonly meta: CharterMeta;
  readonly sourcePath: string;
  readonly hash: string;
  readonly #edges: ReadonlyMap<string, Edge>;

  private constructor(meta: CharterMeta, edges: Edge[], sourcePath: string, hash: string) {
    this.meta = meta;
    this.#edges = new Map(edges.map((e) => [e.id, e]));
    this.sourcePath = sourcePath;
    this.hash = hash;
    Object.freeze(this);
  }

  static load(sourcePath?: string): Charter {
    const file = sourcePath ?? path.join(findHome(), "CHARTER.md");
    if (!fs.existsSync(file)) {
      throw new CharterError(`no charter at ${file} — the Embassy cannot open`);
    }
    const text = fs.readFileSync(file, "utf-8");
    const meta = parseFrontmatter(text);
    const edges = parseTable(extractChannelsSection(text));
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    return new Charter(meta, edges, file, hash);
  }

  /** Re-read the same file. There is no path to load a different one from a running Charter. */
  reload(): Charter {
    return Charter.load(this.sourcePath);
  }

  list(): Edge[] {
    return [...this.#edges.values()];
  }

  /**
   * The only way code obtains an Edge. There is no path from a raw string to
   * an adapter call that does not pass through here.
   */
  resolve(id: string): Edge {
    const edge = this.#edges.get(id);
    if (!edge) {
      throw new ScopeViolation(`'${id}' is not in the charter — outside scope '${this.meta.scope}'`);
    }
    return edge;
  }

  assertReadable(id: string): Edge {
    const edge = this.resolve(id);
    if (!edge.readable) {
      throw new ScopeViolation(`'${id}' (${edge.role}/${edge.direction}) cannot be read`);
    }
    return edge;
  }

  assertWritable(id: string): Edge {
    const edge = this.resolve(id);
    if (!edge.writable) {
      throw new ScopeViolation(`'${id}' (${edge.role}/${edge.direction}) cannot be written`);
    }
    return edge;
  }

  /**
   * Validate a full crossing: every source readable, the destination
   * writable. Returns the transform the destination declares.
   */
  assertCrossing(fromIds: string[], toId: string): { from: Edge[]; to: Edge; transform: string } {
    if (!fromIds.length) throw new ScopeViolation("a crossing needs at least one source edge");
    const from = fromIds.map((id) => this.assertReadable(id));
    const to = this.assertWritable(toId);
    if (from.some((f) => f.id === to.id)) {
      throw new ScopeViolation(`'${to.id}' cannot be both source and destination of one crossing`);
    }
    return { from, to, transform: to.transform };
  }
}
