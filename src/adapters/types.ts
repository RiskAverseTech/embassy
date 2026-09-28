/**
 * Adapters translate a charter Edge into platform-native calls.
 *
 * Every method takes an `Edge`, never a channel string, and every adapter
 * calls `requireEdge()` first. So even a value that got past the type system
 * (an `any`, a parsed JSON blob, `Object.create(Edge.prototype)`) is refused
 * at runtime: only values `Charter.load()` minted pass the private-field
 * brand check. The wall is structural AND checked.
 */

import { Edge } from "../charter";

export interface InboundMessage {
  id: string;
  channel: string;
  author: string;
  title: string;
  body: string;
  at: string;
  url?: string;
  signal?: number;
  inReplyTo?: string;
}

export interface DeliveryRef {
  id: string;
  url: string;
}

export interface Adapter {
  readonly platform: string;
  /** What this adapter can do, so the CLI can refuse a command before trying. */
  readonly capabilities: ReadonlySet<"read" | "write" | "reply">;
  read(edge: Edge, limit?: number): Promise<InboundMessage[]>;
  write(edge: Edge, title: string, body: string): Promise<DeliveryRef>;
  reply?(edge: Edge, inReplyTo: string, body: string): Promise<DeliveryRef>;
}

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export class ForgedEdge extends Error {
  constructor() {
    super("adapter received a value that is not a charter-minted Edge — refused");
    this.name = "ForgedEdge";
  }
}

export class NoAdapter extends Error {
  constructor(platform: string, known: string[]) {
    super(`no adapter for platform '${platform}' — registered: ${known.join(", ") || "none"}`);
    this.name = "NoAdapter";
  }
}

/** Every adapter method begins with this. */
export function requireEdge(value: unknown, platform: string): asserts value is Edge {
  if (!Edge.is(value)) throw new ForgedEdge();
  if (value.platform !== platform) {
    throw new AdapterError(`edge '${value.id}' is for platform '${value.platform}', not '${platform}'`);
  }
}

export const FETCH_TIMEOUT_MS = 30_000;
