/**
 * Moltbook adapter.
 *
 * Carries over v1's API handling. The difference is that it can no longer be
 * pointed anywhere: it receives an Edge that the charter produced, and reads
 * the address off that.
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { Edge } from "../charter";
import { Adapter, AdapterError, InboundMessage } from "./types";

const API_BASE = "https://www.moltbook.com/api/v1";
const CREDENTIALS_FILE = path.join(os.homedir(), ".config", "embassy", "credentials.json");

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
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
}

export class MoltbookAdapter implements Adapter {
  readonly platform = "moltbook";
  private creds: Credentials;

  constructor(creds: Credentials) {
    this.creds = creds;
  }

  static fromDisk(): MoltbookAdapter {
    const creds = loadCredentials();
    if (!creds) {
      throw new AdapterError(
        "no Moltbook credentials — run `npm run embassy -- register` first"
      );
    }
    return new MoltbookAdapter(creds);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.creds.api_key}`,
      "Content-Type": "application/json",
    };
  }

  async read(edge: Edge, limit: number = 25): Promise<InboundMessage[]> {
    // The edge's channel is either a feed query ("posts?sort=hot") or a
    // submolt ("m/general"). Both are addresses the charter approved.
    const channel = edge.channel;
    const url = channel.startsWith("m/")
      ? `${API_BASE}/posts?submolt=${encodeURIComponent(channel.slice(2))}&limit=${limit}`
      : `${API_BASE}/${channel}${channel.includes("?") ? "&" : "?"}limit=${limit}`;

    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw new AdapterError(
        `moltbook read on '${edge.id}' failed: ${response.status} ${await response.text()}`
      );
    }

    const data = (await response.json()) as any;
    const posts = data.posts || data.data || [];

    return posts.map(
      (p: any): InboundMessage => ({
        id: p.id,
        author: p.author?.name || "unknown",
        title: p.title || "",
        body: p.content || "",
        at: p.created_at || new Date().toISOString(),
        url: p.id ? `https://moltbook.com/post/${p.id}` : undefined,
        signal: p.upvotes ?? 0,
      })
    );
  }

  async write(edge: Edge, title: string, body: string): Promise<string> {
    if (!edge.channel.startsWith("m/")) {
      throw new AdapterError(
        `edge '${edge.id}' addresses '${edge.channel}', which is a feed, not a postable submolt`
      );
    }
    const submolt = edge.channel.slice(2);

    const response = await fetch(`${API_BASE}/posts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ submolt, title, content: body }),
    });

    if (!response.ok) {
      throw new AdapterError(
        `moltbook write to '${edge.id}' failed: ${response.status} ${await response.text()}`
      );
    }

    const data = (await response.json()) as any;
    const id = data.post?.id || data.id || "unknown";
    return `https://moltbook.com/post/${id}`;
  }

  async register(name: string, description: string): Promise<Credentials | null> {
    const response = await fetch(`${API_BASE}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    if (!response.ok) return null;

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
    const response = await fetch(`${API_BASE}/agents/status`, {
      headers: this.headers(),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as any;
    return data.status === "claimed";
  }
}
