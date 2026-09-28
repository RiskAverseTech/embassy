/**
 * Moltbook adapter.
 *
 * Carries over the API handling that v1 exercised in production (feed reads,
 * post creation, comment creation, claim status). It cannot be pointed
 * anywhere: it receives a charter-minted Edge and reads the address off it,
 * and the address itself must match a small grammar — a feed query or a
 * submolt — so a charter row cannot turn the adapter into a general HTTP
 * client against the API.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { Edge } from "../charter";
import {
  Adapter,
  AdapterError,
  DeliveryRef,
  FETCH_TIMEOUT_MS,
  InboundMessage,
  requireEdge,
} from "./types";

const API_BASE = "https://www.moltbook.com/api/v1";
const CREDENTIALS_FILE = path.join(os.homedir(), ".config", "embassy", "credentials.json");

const FEED = /^posts\?sort=(hot|new|top)$/;
const SUBMOLT = /^m\/([a-z0-9][a-z0-9_-]{0,63})$/i;

export interface Credentials {
  api_key: string;
  claim_url?: string;
  verification_code?: string;
  registered_at: string;
}

export function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CREDENTIALS_FILE)) return null;
  return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** Validate a charter channel string against what this adapter will address. */
export function parseChannel(channel: string): { kind: "feed"; sort: string } | { kind: "submolt"; name: string } {
  const feed = channel.match(FEED);
  if (feed) return { kind: "feed", sort: feed[1] };
  const sub = channel.match(SUBMOLT);
  if (sub) return { kind: "submolt", name: sub[1] };
  throw new AdapterError(
    `moltbook channel '${channel}' is not addressable — use 'posts?sort=hot|new|top' or 'm/<submolt>'`
  );
}

async function call(url: string, init: RequestInit & { apiKey: string }): Promise<any> {
  const { apiKey, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(rest.headers ?? {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new AdapterError(`moltbook ${rest.method ?? "GET"} ${url} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

export class MoltbookAdapter implements Adapter {
  readonly platform = "moltbook";
  readonly capabilities = new Set<"read" | "write" | "reply">(["read", "write", "reply"]);
  #creds: Credentials;

  constructor(creds: Credentials) {
    this.#creds = creds;
  }

  static fromDisk(): MoltbookAdapter {
    const creds = loadCredentials();
    if (!creds) throw new AdapterError("no Moltbook credentials — run `embassy register` first");
    return new MoltbookAdapter(creds);
  }

  async read(edge: Edge, limit: number = 25): Promise<InboundMessage[]> {
    requireEdge(edge, this.platform);
    const addr = parseChannel(edge.channel);

    // v1 exercised `posts?sort=…`. The submolt filter is the same endpoint
    // with a documented query parameter; it has not been exercised live.
    const url =
      addr.kind === "feed"
        ? `${API_BASE}/posts?sort=${addr.sort}&limit=${limit}`
        : `${API_BASE}/posts?submolt=${encodeURIComponent(addr.name)}&limit=${limit}`;

    const data = await call(url, { apiKey: this.#creds.api_key });
    const posts: any[] = data.posts || data.data || [];

    return posts
      .filter((p) => typeof p?.id === "string" && p.id.length > 0)
      .map(
        (p): InboundMessage => ({
          id: p.id,
          channel: p.submolt ? `m/${p.submolt}` : edge.channel,
          author: p.author?.name || "unknown",
          title: p.title || "",
          body: p.content || "",
          at: p.created_at || new Date().toISOString(),
          url: `https://moltbook.com/post/${p.id}`,
          signal: p.upvotes ?? 0,
        })
      );
  }

  async write(edge: Edge, title: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    const addr = parseChannel(edge.channel);
    if (addr.kind !== "submolt") {
      throw new AdapterError(`edge '${edge.id}' addresses a feed, which cannot be posted to`);
    }

    const data = await call(`${API_BASE}/posts`, {
      method: "POST",
      apiKey: this.#creds.api_key,
      body: JSON.stringify({ submolt: addr.name, title, content: body }),
    });
    const id = data.post?.id || data.id;
    if (!id) throw new AdapterError("moltbook accepted the post but returned no id");
    return { id, url: `https://moltbook.com/post/${id}` };
  }

  /** Comment on a post. Endpoint exercised by v1's `reply` command. */
  async reply(edge: Edge, inReplyTo: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    const data = await call(`${API_BASE}/posts/${encodeURIComponent(inReplyTo)}/comments`, {
      method: "POST",
      apiKey: this.#creds.api_key,
      body: JSON.stringify({ content: body }),
    });
    const id = data.comment?.id || data.id || inReplyTo;
    return { id, url: `https://moltbook.com/post/${inReplyTo}` };
  }

  async register(name: string, description: string): Promise<Credentials | null> {
    const response = await fetch(`${API_BASE}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AdapterError(`registration failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    const data = (await response.json()) as any;
    if (!data.agent) return null;

    const creds: Credentials = {
      api_key: data.agent.api_key,
      claim_url: data.agent.claim_url,
      verification_code: data.agent.verification_code,
      registered_at: new Date().toISOString(),
    };
    saveCredentials(creds);
    return creds;
  }

  async claimed(): Promise<boolean> {
    try {
      const data = await call(`${API_BASE}/agents/status`, { apiKey: this.#creds.api_key });
      return data.status === "claimed";
    } catch {
      return false;
    }
  }
}
