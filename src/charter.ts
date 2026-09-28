/**
 * The charter: the Embassy's single source of truth.
 *
 * Channel access is defined in CHARTER.md and enforced here. Nothing in this
 * module consults a prompt, a model, or an environment variable to decide
 * whether a crossing is allowed.
 */

import fs from "fs";
import path from "path";

export type Role = "listen" | "speak" | "report" | "both";
export type Direction = "in" | "out" | "both";

export interface RateLimit {
  count: number;
  per: "hour" | "day";
}

export interface Edge {
  id: string;
  platform: string;
  channel: string;
  role: Role;
  direction: Direction;
  transform: string;
  rate: RateLimit | null;
}

export interface CharterMeta {
  embassy: string;
  version: string;
  scope: string;
  default: "deny" | "allow";
  provenance: "required" | "optional";
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

function parseFrontmatter(text: string): CharterMeta {
  const match = text.match(/^---\s*$([\s\S]*?)^---\s*$/m);
  if (!match) {
    throw new CharterError("charter has no --- frontmatter block");
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }

  for (const required of ["embassy", "version", "scope", "default"]) {
    if (!fields[required]) {
      throw new CharterError(`charter frontmatter is missing '${required}'`);
    }
  }

  if (fields.default !== "deny" && fields.default !== "allow") {
    throw new CharterError(
      `charter 'default' must be 'deny' or 'allow', got '${fields.default}'`
    );
  }

  // An Embassy that defaults to allow is not an Embassy. Refuse to run.
  if (fields.default === "allow") {
    throw new CharterError(
      "charter sets default: allow — the Embassy refuses to run without a wall"
    );
  }

  return {
    embassy: fields.embassy,
    version: fields.version,
    scope: fields.scope,
    default: "deny",
    provenance: fields.provenance === "optional" ? "optional" : "required",
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

function parseTable(text: string): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    if (cells.length !== 7) continue;
    if (cells[0].toLowerCase() === "id") continue; // header
    if (/^:?-{2,}:?$/.test(cells[0])) continue; // separator

    const [id, platform, channel, role, direction, transform, rate] = cells;

    if (!ROLES.includes(role as Role)) {
      throw new CharterError(
        `edge '${id}' has role '${role}' — must be one of ${ROLES.join(", ")}`
      );
    }
    if (!DIRECTIONS.includes(direction as Direction)) {
      throw new CharterError(
        `edge '${id}' has direction '${direction}' — must be one of ${DIRECTIONS.join(", ")}`
      );
    }
    if (!transform) {
      throw new CharterError(`edge '${id}' declares no transform`);
    }
    if (seen.has(id)) {
      throw new CharterError(`edge '${id}' is declared twice`);
    }
    seen.add(id);

    edges.push({
      id,
      platform,
      channel,
      role: role as Role,
      direction: direction as Direction,
      transform,
      rate: parseRate(rate),
    });
  }

  if (!edges.length) {
    throw new CharterError("charter declares no channels");
  }
  return edges;
}

export class Charter {
  readonly meta: CharterMeta;
  readonly edges: Map<string, Edge>;
  readonly sourcePath: string;

  private constructor(meta: CharterMeta, edges: Edge[], sourcePath: string) {
    this.meta = meta;
    this.edges = new Map(edges.map((e) => [e.id, e]));
    this.sourcePath = sourcePath;
  }

  static load(sourcePath?: string): Charter {
    const file = sourcePath ?? path.join(__dirname, "..", "CHARTER.md");
    if (!fs.existsSync(file)) {
      throw new CharterError(`no charter at ${file} — the Embassy cannot open`);
    }
    const text = fs.readFileSync(file, "utf-8");
    return new Charter(parseFrontmatter(text), parseTable(text), file);
  }

  reload(): Charter {
    return Charter.load(this.sourcePath);
  }

  list(): Edge[] {
    return [...this.edges.values()];
  }

  /**
   * The only way code obtains a channel. There is no path from a raw string
   * to an adapter call that does not pass through here.
   */
  resolve(id: string): Edge {
    const edge = this.edges.get(id);
    if (!edge) {
      throw new ScopeViolation(
        `'${id}' is not in the charter — outside scope '${this.meta.scope}'`
      );
    }
    return edge;
  }

  assertReadable(id: string): Edge {
    const edge = this.resolve(id);
    if (edge.role !== "listen" && edge.role !== "both") {
      throw new ScopeViolation(`'${id}' has role '${edge.role}' — cannot be read`);
    }
    if (edge.direction !== "in" && edge.direction !== "both") {
      throw new ScopeViolation(
        `'${id}' has direction '${edge.direction}' — nothing flows inward`
      );
    }
    return edge;
  }

  assertWritable(id: string): Edge {
    const edge = this.resolve(id);
    if (edge.role === "listen") {
      throw new ScopeViolation(`'${id}' is listen-only — the Embassy does not speak there`);
    }
    if (edge.direction !== "out" && edge.direction !== "both") {
      throw new ScopeViolation(
        `'${id}' has direction '${edge.direction}' — nothing flows outward`
      );
    }
    return edge;
  }

  /**
   * Validate a full crossing. Returns both ends and the transform that the
   * destination declares. Rate is checked by the relay against the ledger.
   */
  assertCrossing(fromId: string, toId: string): { from: Edge; to: Edge; transform: string } {
    const from = this.assertReadable(fromId);
    const to = this.assertWritable(toId);
    return { from, to, transform: to.transform };
  }
}
