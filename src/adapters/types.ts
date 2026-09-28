/**
 * Adapters translate a charter Edge into platform-native calls.
 *
 * Every method takes an `Edge`, never a channel string, and every adapter
 * calls `requireEdge()` first. So even a value that got past the type system
 * (an `any`, a parsed JSON blob, `Object.create(Edge.prototype)`) is refused
 * at runtime: only values `Charter.load()` minted pass the private-field
 * brand check. The wall is structural AND checked.
 *
 * An adapter instance is bound to ONE platform alias from the charter's
 * Platforms table (e.g. `moltbook`, `clawk`), which fixes its base URL and
 * its credentials file. The same adapter kind can serve several aliases.
 */

import { Edge, Platform } from "../charter";

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

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface Adapter {
  /** The charter platform alias this instance serves. */
  readonly platform: string;
  readonly kind: string;
  readonly capabilities: ReadonlySet<"read" | "write" | "reply">;
  read(edge: Edge, limit?: number): Promise<InboundMessage[]>;
  write(edge: Edge, title: string, body: string): Promise<DeliveryRef>;
  reply?(edge: Edge, inReplyTo: string, body: string): Promise<DeliveryRef>;
  /** Interactive one-time setup (register, paste a token). Prints instructions; returns when done or when a human step is pending. */
  setup?(): Promise<string>;
  /** Non-interactive health check for `doctor`. Must not write anything. */
  check(): Promise<CheckResult>;
}

/** What the factory hands every adapter. `fetch` is injectable for tests. */
export interface AdapterContext {
  platform: Platform;
  credentials: Record<string, string> | null;
  fetch: typeof fetch;
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

export class NotConfigured extends Error {
  constructor(platform: string, hint: string) {
    super(`platform '${platform}' has no credentials — ${hint}`);
    this.name = "NotConfigured";
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

/** Shared JSON call with timeout and bounded error text. Never follows a redirect off-host. */
export async function callJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
): Promise<any> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new AdapterError(`${init.method ?? "GET"} ${url} → redirect (${response.status}) refused; credentials are never followed off-host`);
  }
  if (!response.ok) {
    throw new AdapterError(`${init.method ?? "GET"} ${url} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new AdapterError(`${init.method ?? "GET"} ${url} → ${response.status} but the body is not JSON: ${text.slice(0, 120)}`); }
}
