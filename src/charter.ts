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
import { step as fenceStep, stripFenced } from "./fences";

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
  /** Aliases explicitly allowed to point a known dialect at a host other than its well-known one (self-hosted forks). */
  offhost: readonly string[];
}

/** A platform alias bound to an adapter kind and (usually) a base URL. */
export interface Platform {
  readonly id: string;
  readonly adapter: string;
  readonly base: string | null;
}

/** A named crossing: which edges feed which destination, under what title. */
export interface Route {
  readonly id: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly title: string;
}

/** Adapter kinds the charter may name. The factory in adapters/index.ts must agree. */
export const ADAPTER_KINDS = [
  "console",
  "molt/moltbook",
  "molt/clawk",
  "molt/4claw",
  "agent4science",
  "a2a",
  "discord",
] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

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
const DEFAULT_MODEL = "claude-sonnet-5";

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
    offhost: Object.freeze((fields.offhost ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
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
 * Sections. Only the first table directly under a recognized `## Heading` is
 * read; rows in prose, in other sections, or inside fenced code blocks or
 * HTML comments are not data. A duplicate heading is an error, not a merge.
 */
function extractSection(text: string, heading: string, required: boolean): string | null {
  const lines = text.split("\n");
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "i");
  let start = -1;
  let end = lines.length;
  let count = 0;

  // A heading inside a fenced block is text, not structure — so a fenced
  // example containing "## Channels" neither starts nor ends a section.
  // Fences close only with a matching fence (see fences.ts).
  let fence: import("./fences").Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const r = fenceStep(fence, lines[i]);
    fence = r.state;
    if (r.marker || fence) continue;
    if (re.test(lines[i])) {
      count++;
      if (start < 0) start = i + 1;
    } else if (start >= 0 && end === lines.length && /^#{1,6}\s/.test(lines[i])) {
      end = i;
    }
  }

  if (count === 0) {
    if (required) throw new CharterError(`charter has no '## ${heading}' section`);
    return null;
  }
  if (count > 1) throw new CharterError(`charter has more than one '## ${heading}' section`);

  // A comment opened inside a table row could splice rows together. Refuse.
  for (const line of lines.slice(start, end)) {
    if (line.trim().startsWith("|") && /<!--|-->/.test(line)) {
      throw new CharterError(`HTML comment markers are not allowed inside a ${heading.toLowerCase()} row: ${line.trim()}`);
    }
  }
  const section = lines.slice(start, end).join("\n").replace(/<!--[\s\S]*?-->/g, "");
  return stripFenced(section).join("\n");
}

/** The first pipe table in a section, as rows of cells. Header must match exactly. */
function readTable(section: string, heading: string, expected: string[]): string[][] {
  const rows: string[][] = [];
  let headerSeen = false;

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (headerSeen && trimmed) break; // any other content ends the table
      continue;
    }
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());

    if (!headerSeen) {
      if (cells.map((c) => c.toLowerCase()).join(",") !== expected.join(",")) {
        throw new CharterError(`${heading} table header must be exactly: ${expected.join(" | ")}`);
      }
      headerSeen = true;
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
    if (cells.length !== expected.length) {
      throw new CharterError(`${heading} row has ${cells.length} cells, expected ${expected.length}: ${trimmed}`);
    }
    rows.push(cells);
  }

  if (!headerSeen) throw new CharterError(`'## ${heading}' section contains no table`);
  return rows;
}

const ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;
const EMPTY = (s: string) => !s || s === "—" || s === "-";

/**
 * A platform base is an https origin plus an optional path, and nothing
 * else: no userinfo, no query, no fragment, no IP literal, and an ASCII
 * hostname only — a Cyrillic 'о' in "mоltbook.com" is invisible in a diff,
 * so it is refused rather than displayed.
 */
export function normalizeBase(id: string, raw: string): string {
  if (/[%\x00-\x20\x7f]/.test(raw)) throw new CharterError(`platform '${id}' base must not contain percent-escapes, whitespace, or control characters`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new CharterError(`platform '${id}' base '${raw}' is not a URL`); }
  if (u.protocol !== "https:") throw new CharterError(`platform '${id}' base must be https:// (got ${u.protocol})`);
  if (u.username || u.password) throw new CharterError(`platform '${id}' base must not carry credentials (user@host)`);
  if (u.search || u.hash || /[?#]$/.test(raw)) throw new CharterError(`platform '${id}' base must not have a query or fragment`);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(u.hostname)) {
    throw new CharterError(`platform '${id}' base host '${u.hostname}' must be an ASCII domain name (no IP literals, no punycode/IDN)`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) throw new CharterError(`platform '${id}' base must not be an IP literal`);
  // WHATWG URL silently punycodes an IDN host ("mоltbook" with a Cyrillic о → xn--mltbook-9ig); refuse the encoded form too.
  if (/(^|\.)xn--/i.test(u.hostname) || /[^\x00-\x7f]/.test(raw)) throw new CharterError(`platform '${id}' base host must be plain ASCII — '${raw}' contains an internationalized label (${u.hostname})`);
  if (u.port) throw new CharterError(`platform '${id}' base must use the default https port`);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function parsePlatforms(section: string): Platform[] {
  const out: Platform[] = [];
  const seen = new Set<string>();
  for (const [id, adapter, base] of readTable(section, "Platforms", ["platform", "adapter", "base"])) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new CharterError(`platform '${id}' must be lowercase (e.g. moltbook, clawk)`);
    if (!(ADAPTER_KINDS as readonly string[]).includes(adapter)) {
      throw new CharterError(`platform '${id}' names adapter '${adapter}' — known: ${ADAPTER_KINDS.join(", ")}`);
    }
    const url = EMPTY(base) ? null : normalizeBase(id, base);
    if (adapter !== "console" && !url) throw new CharterError(`platform '${id}' (${adapter}) needs a base URL`);
    if (seen.has(id)) throw new CharterError(`platform '${id}' is declared twice`);
    seen.add(id);
    out.push(Object.freeze({ id, adapter, base: url }));
  }
  if (!out.length) throw new CharterError("charter declares no platforms");
  return out;
}

function parseChannels(section: string, platforms: Map<string, Platform>): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const header = ["id", "platform", "channel", "role", "direction", "transform", "rate"];

  for (const [id, platform, channel, role, direction, transform, rate] of readTable(section, "Channels", header)) {
    if (!ID.test(id)) throw new CharterError(`edge id '${id}' must be dotted lowercase (e.g. agent.hot)`);
    if (!platforms.has(platform)) {
      throw new CharterError(`edge '${id}' names platform '${platform}', which is not in the Platforms table`);
    }
    if (!ROLES.includes(role as Role)) throw new CharterError(`edge '${id}' has role '${role}' — must be one of ${ROLES.join(", ")}`);
    if (!DIRECTIONS.includes(direction as Direction)) throw new CharterError(`edge '${id}' has direction '${direction}' — must be one of ${DIRECTIONS.join(", ")}`);
    if (!TRANSFORMS[transform]) {
      throw new CharterError(`edge '${id}' declares transform '${transform}', which is not registered — known: ${Object.keys(TRANSFORMS).join(", ")}`);
    }
    if (seen.has(id)) throw new CharterError(`edge '${id}' is declared twice`);
    seen.add(id);
    edges.push(mintEdge({ id, platform, channel, role: role as Role, direction: direction as Direction, transform, rate: parseRate(rate) }));
  }

  if (!edges.length) throw new CharterError("charter declares no channels");
  if (!edges.some((e) => e.readable)) throw new CharterError("charter has no readable edge — nothing can come in");
  if (!edges.some((e) => e.writable)) throw new CharterError("charter has no writable edge — nothing can go out");
  return edges;
}

function parseRoutes(section: string | null, edges: Map<string, Edge>): Route[] {
  if (section === null) return [];
  const out: Route[] = [];
  const seen = new Set<string>();
  for (const [id, from, to, title] of readTable(section, "Routes", ["route", "from", "to", "title"])) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new CharterError(`route '${id}' must be lowercase (e.g. bulletin)`);
    const fromIds = from.split("+").map((s) => s.trim()).filter(Boolean);
    if (!fromIds.length) throw new CharterError(`route '${id}' has no source edges`);
    for (const f of fromIds) {
      const e = edges.get(f);
      if (!e) throw new CharterError(`route '${id}' reads from '${f}', which is not a channel`);
      if (!e.readable) throw new CharterError(`route '${id}' reads from '${f}', which cannot be read`);
    }
    const dest = edges.get(to);
    if (!dest) throw new CharterError(`route '${id}' writes to '${to}', which is not a channel`);
    if (!dest.writable) throw new CharterError(`route '${id}' writes to '${to}', which cannot be written`);
    if (fromIds.includes(to)) throw new CharterError(`route '${id}' has '${to}' as both source and destination`);
    if (seen.has(id)) throw new CharterError(`route '${id}' is declared twice`);
    seen.add(id);
    out.push(Object.freeze({ id, from: Object.freeze(fromIds), to, title: EMPTY(title) ? "" : title }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Charter
// ---------------------------------------------------------------------------

export class Charter {
  readonly meta: CharterMeta;
  readonly sourcePath: string;
  readonly hash: string;
  readonly #platforms: ReadonlyMap<string, Platform>;
  readonly #edges: ReadonlyMap<string, Edge>;
  readonly #routes: ReadonlyMap<string, Route>;

  private constructor(meta: CharterMeta, platforms: Platform[], edges: Edge[], routes: Route[], sourcePath: string, hash: string) {
    this.meta = meta;
    this.#platforms = new Map(platforms.map((p) => [p.id, p]));
    this.#edges = new Map(edges.map((e) => [e.id, e]));
    this.#routes = new Map(routes.map((r) => [r.id, r]));
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
    const platforms = parsePlatforms(extractSection(text, "Platforms", true)!);
    const platformMap = new Map(platforms.map((p) => [p.id, p]));
    const edges = parseChannels(extractSection(text, "Channels", true)!, platformMap);
    const routes = parseRoutes(extractSection(text, "Routes", false), new Map(edges.map((e) => [e.id, e])));
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    return new Charter(meta, platforms, edges, routes, file, hash);
  }

  /** Re-read the same file. There is no path to load a different one from a running Charter. */
  reload(): Charter {
    return Charter.load(this.sourcePath);
  }

  list(): Edge[] {
    return [...this.#edges.values()];
  }

  platforms(): Platform[] {
    return [...this.#platforms.values()];
  }

  platform(id: string): Platform {
    const p = this.#platforms.get(id);
    if (!p) throw new CharterError(`platform '${id}' is not in the charter`);
    return p;
  }

  routes(): Route[] {
    return [...this.#routes.values()];
  }

  route(id: string): Route {
    const r = this.#routes.get(id);
    if (!r) throw new ScopeViolation(`'${id}' is not a route in the charter — known: ${[...this.#routes.keys()].join(", ") || "none"}`);
    return r;
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
