/**
 * The "molt" family: agent social networks that follow the OpenClaw
 * convention — `POST /agents/register` returning a bearer key, a human
 * claim step, Bearer auth on everything else. Moltbook set the pattern;
 * Clawk and 4claw copied it. Their READ and WRITE paths differ, so each is a
 * dialect of one adapter rather than a separate adapter.
 *
 * Endpoint shapes come from each site's published skill.md (Moltbook
 * 1.12.0, Clawk 2.10.0, 4claw 0.2.4) as read on 2026-09-12. Moltbook's feed
 * reads (`posts?sort=`), submolt reads (`posts?submolt=`), and post/comment
 * writes were exercised live by v1 in January–February 2026; both reads were
 * confirmed public (no key) on 2026-09-28, after the site changed hands, so
 * a fresh install can run a read-only route before registering.
 * Clawk and 4claw are implemented from their docs and have not been
 * exercised live from this codebase — `doctor` will tell you if the
 * status call works, and `--dry-run` shows the exact request.
 *
 * Adding a dialect means adding an entry to DIALECTS: channel grammar,
 * request shaping, response extraction. Nothing else changes.
 */

import { Edge } from "../charter";
import {
  Adapter,
  AdapterContext,
  AdapterError,
  CheckResult,
  DeliveryRef,
  InboundMessage,
  NotConfigured,
  callJson,
  requireEdge,
} from "./types";
import { saveCredentials } from "../credentials";

/** `public: true` means the site serves this read without a key (verified live); the adapter then reads anonymously when none is configured. */
type ReadPlan = { path: string; query: Record<string, string>; extract: (json: any) => any[]; public?: boolean };
type WritePlan = { path: string; body: (title: string, content: string) => Record<string, unknown>; idFrom: (json: any) => string | undefined };
type ReplyPlan = { path: (id: string) => string; body: (content: string) => Record<string, unknown> };

interface Dialect {
  kind: string;
  headers: Record<string, string>;
  /** A body longer than this is refused, never truncated. */
  maxBody: number | null;
  register: { path: string; body: (name: string, description: string) => Record<string, unknown>; keyFrom: (json: any) => string | undefined; claimFrom: (json: any) => { url?: string; code?: string } };
  status: { path: string; ok: (json: any) => boolean };
  read: (channel: string) => ReadPlan | null;
  write: (channel: string) => WritePlan | null;
  reply: ReplyPlan | null;
  item: (raw: any, site: string, channel: string) => InboundMessage | null;
}

const first = (json: any, keys: string[]): any[] => {
  if (Array.isArray(json)) return json;
  for (const k of keys) if (Array.isArray(json?.[k])) return json[k];
  return [];
};
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const author = (raw: any): string => str(raw?.author?.name ?? raw?.agent?.name ?? raw?.agent_name ?? raw?.author_name ?? raw?.author ?? "unknown");

const SLUG = "[a-z0-9][a-z0-9_-]{0,63}";

const DIALECTS: Record<string, Dialect> = {
  "molt/moltbook": {
    kind: "molt/moltbook",
    headers: {},
    maxBody: null,
    register: {
      path: "/agents/register",
      body: (name, description) => ({ name, description }),
      keyFrom: (j) => j?.api_key ?? j?.agent?.api_key,
      claimFrom: (j) => ({ url: j?.claim_url ?? j?.agent?.claim_url, code: j?.verification_code ?? j?.agent?.verification_code }),
    },
    status: { path: "/agents/status", ok: (j) => j?.status === "claimed" },
    read: (channel): ReadPlan | null => {
      const feed = channel.match(/^posts\?sort=(hot|new|top|rising)$/);
      if (feed) return { path: "/posts", query: { sort: feed[1] }, extract: (j) => first(j, ["posts", "data"]), public: true };
      const sub = channel.match(new RegExp(`^m/(${SLUG})$`, "i"));
      if (sub) return { path: "/posts", query: { submolt: sub[1], sort: "new" }, extract: (j) => first(j, ["posts", "data"]), public: true };
      return null;
    },
    write: (channel) => {
      const sub = channel.match(new RegExp(`^m/(${SLUG})$`, "i"));
      if (!sub) return null;
      return {
        path: "/posts",
        body: (title, content) => ({ submolt_name: sub[1], title, content, type: "text" }),
        idFrom: (j) => j?.post?.id ?? j?.id,
      };
    },
    reply: { path: (id) => `/posts/${encodeURIComponent(id)}/comments`, body: (content) => ({ content }) },
    item: (raw, site, channel) =>
      typeof raw?.id === "string" && raw.id
        ? {
            id: raw.id,
            channel: raw.submolt ? `m/${raw.submolt}` : channel,
            author: author(raw),
            title: str(raw.title),
            body: str(raw.content),
            at: str(raw.created_at) || new Date().toISOString(),
            url: `${site}/post/${raw.id}`,
            signal: Number(raw.upvotes ?? 0) || 0,
          }
        : null,
  },

  "molt/clawk": {
    kind: "molt/clawk",
    headers: { "X-Skill-Version": "2.10.0" },
    maxBody: 400,
    register: {
      path: "/agents/register",
      body: (name, description) => ({ name, description }),
      keyFrom: (j) => j?.api_key ?? j?.agent?.api_key,
      claimFrom: (j) => ({ url: j?.claim_url ?? j?.agent?.claim_url, code: j?.verification_code ?? j?.agent?.verification_code }),
    },
    status: { path: "/agents/status", ok: (j) => j?.status === "claimed" || j?.claimed === true },
    read: (channel): ReadPlan | null => {
      const explore = channel.match(/^explore\?sort=(ranked|recent)$/);
      if (explore) return { path: "/explore", query: { sort: explore[1] }, extract: (j) => first(j, ["clawks", "items", "data", "posts"]) };
      if (channel === "timeline") return { path: "/timeline", query: {}, extract: (j) => first(j, ["clawks", "items", "data", "posts"]) };
      const agent = channel.match(/^agent\/([A-Za-z0-9_-]{1,64})$/);
      if (agent) return { path: `/agents/${agent[1]}`, query: {}, extract: (j) => first(j, ["clawks", "items", "data", "posts"]) };
      const tag = channel.match(/^tag\/([A-Za-z0-9_]{1,64})$/);
      if (tag) return { path: "/search", query: { q: `#${tag[1]}` }, extract: (j) => first(j, ["clawks", "results", "items", "data"]) };
      return null;
    },
    write: (channel) =>
      channel === "clawks"
        ? { path: "/clawks", body: (_title, content) => ({ content }), idFrom: (j) => j?.clawk?.id ?? j?.id }
        : null,
    reply: { path: () => "/clawks", body: (content) => ({ content }) }, // reply_to_id merged in by reply()
    item: (raw, site, channel) =>
      typeof raw?.id === "string" && raw.id
        ? {
            id: raw.id,
            channel,
            author: author(raw),
            title: "",
            body: str(raw.content ?? raw.text),
            at: str(raw.created_at) || new Date().toISOString(),
            url: `${site}/clawks/${raw.id}`,
            signal: Number(raw.likes ?? raw.like_count ?? 0) || 0,
            inReplyTo: raw.reply_to_id ? str(raw.reply_to_id) : undefined,
          }
        : null,
  },

  "molt/4claw": {
    kind: "molt/4claw",
    headers: {},
    maxBody: null,
    register: {
      path: "/agents/register",
      body: (name, description) => ({ name, description }),
      keyFrom: (j) => j?.agent?.api_key ?? j?.api_key,
      claimFrom: () => ({}),
    },
    status: { path: "/boards", ok: (j) => Array.isArray(j) || Array.isArray(j?.boards) },
    read: (channel): ReadPlan | null => {
      const board = channel.match(new RegExp(`^boards/(${SLUG})$`, "i"));
      if (board) return { path: `/boards/${board[1]}/threads`, query: { includeContent: "1" }, extract: (j) => first(j, ["threads", "data"]) };
      const thread = channel.match(/^thread\/([A-Za-z0-9_-]{1,64})$/);
      if (thread) return { path: `/threads/${thread[1]}`, query: {}, extract: (j) => first(j?.replies ?? j?.thread?.replies ?? j, ["replies"]) };
      return null;
    },
    write: (channel) => {
      const board = channel.match(new RegExp(`^boards/(${SLUG})$`, "i"));
      if (!board) return null;
      return {
        path: `/boards/${board[1]}/threads`,
        body: (title, content) => ({ title, content, anon: false }),
        idFrom: (j) => j?.thread?.id ?? j?.id,
      };
    },
    reply: { path: (id) => `/threads/${encodeURIComponent(id)}/replies`, body: (content) => ({ content, anon: false, bump: true }) },
    item: (raw, site, channel) =>
      raw?.id != null && String(raw.id)
        ? {
            id: String(raw.id),
            channel,
            author: author(raw),
            title: str(raw.title),
            body: str(raw.content),
            at: str(raw.created_at) || new Date().toISOString(),
            url: `${site}/thread/${raw.id}`,
            signal: Number(raw.reply_count ?? raw.replies_count ?? 0) || 0,
          }
        : null,
  },
};

export const MOLT_DIALECTS = Object.keys(DIALECTS);

/** Where each dialect actually lives. A charter may point a dialect elsewhere (a self-hosted clone), but `charter` lint says so out loud. */
export const MOLT_KNOWN_HOSTS: Record<string, string> = {
  "molt/moltbook": "www.moltbook.com",
  "molt/clawk": "clawk.ai",
  "molt/4claw": "www.4claw.org",
};

/** Validate a charter channel string for a dialect without any network. Used by `charter` lint. */
export function moltChannelKind(kind: string, channel: string): "read" | "write" | "both" | null {
  const d = DIALECTS[kind];
  if (!d) return null;
  const r = d.read(channel) !== null;
  const w = d.write(channel) !== null;
  return r && w ? "both" : r ? "read" : w ? "write" : null;
}

export class MoltAdapter implements Adapter {
  readonly platform: string;
  readonly kind: string;
  readonly capabilities: ReadonlySet<"read" | "write" | "reply">;
  readonly maxBody: number | null;
  readonly #d: Dialect;
  readonly #base: string;
  readonly #site: string;
  readonly #fetch: typeof fetch;
  #key: string | null;

  constructor(ctx: AdapterContext) {
    const d = DIALECTS[ctx.platform.adapter];
    if (!d) throw new AdapterError(`'${ctx.platform.adapter}' is not a molt dialect — known: ${MOLT_DIALECTS.join(", ")}`);
    this.#d = d;
    this.kind = d.kind;
    this.platform = ctx.platform.id;
    this.#base = ctx.platform.base!.replace(/\/+$/, "");
    this.#site = this.#base.replace(/\/api\/v\d+$/, "");
    this.#fetch = ctx.fetch;
    this.#key = ctx.credentials?.api_key ?? null;
    this.maxBody = d.maxBody;
    this.capabilities = new Set(d.reply ? ["read", "write", "reply"] : ["read", "write"]);
  }

  #auth(): Record<string, string> {
    if (!this.#key) throw new NotConfigured(this.platform, `run: embassy register ${this.platform}`);
    return { Authorization: `Bearer ${this.#key}`, ...this.#d.headers };
  }

  /** Public reads go out without a key when none is configured; with one, it is sent (the site may personalise or rate-limit by it). */
  #authFor(plan: ReadPlan): Record<string, string> {
    if (this.#key || !plan.public) return this.#auth();
    return { ...this.#d.headers };
  }

  #url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(this.#base + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  async read(edge: Edge, limit: number = 25): Promise<InboundMessage[]> {
    requireEdge(edge, this.platform);
    const plan = this.#d.read(edge.channel);
    if (!plan) throw new AdapterError(`${this.kind}: channel '${edge.channel}' is not readable — see the dialect's grammar`);
    const json = await callJson(this.#fetch, this.#url(plan.path, { ...plan.query, limit: String(limit) }), { headers: this.#authFor(plan) });
    return plan.extract(json).map((raw) => this.#d.item(raw, this.#site, edge.channel)).filter((m): m is InboundMessage => m !== null);
  }

  async write(edge: Edge, title: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    const plan = this.#d.write(edge.channel);
    if (!plan) throw new AdapterError(`${this.kind}: channel '${edge.channel}' is not writable — see the dialect's grammar`);
    if (this.maxBody !== null && body.length > this.maxBody) {
      throw new AdapterError(`${this.kind}: body is ${body.length} chars; '${edge.channel}' accepts at most ${this.maxBody}. Nothing sent — the Embassy does not truncate.`);
    }
    const json = await callJson(this.#fetch, this.#url(plan.path), { method: "POST", headers: this.#auth(), body: JSON.stringify(plan.body(title, body)) });
    const id = plan.idFrom(json);
    if (!id) throw new AdapterError(`${this.kind}: accepted the post but returned no id`);
    return { id: String(id), url: `${this.#site}/${this.kind === "molt/moltbook" ? "post" : this.kind === "molt/clawk" ? "clawks" : "thread"}/${id}` };
  }

  async reply(edge: Edge, inReplyTo: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    if (!this.#d.reply) throw new AdapterError(`${this.kind}: replies not supported`);
    if (this.maxBody !== null && body.length > this.maxBody) {
      throw new AdapterError(`${this.kind}: reply is ${body.length} chars; max ${this.maxBody}. Nothing sent.`);
    }
    const payload = { ...this.#d.reply.body(body), ...(this.kind === "molt/clawk" ? { reply_to_id: inReplyTo } : {}) };
    const json = await callJson(this.#fetch, this.#url(this.#d.reply.path(inReplyTo)), { method: "POST", headers: this.#auth(), body: JSON.stringify(payload) });
    const id = json?.comment?.id ?? json?.reply?.id ?? json?.clawk?.id ?? json?.id ?? inReplyTo;
    return { id: String(id), url: `${this.#site}/${this.kind === "molt/moltbook" ? "post" : this.kind === "molt/clawk" ? "clawks" : "thread"}/${inReplyTo}` };
  }

  async setup(): Promise<string> {
    if (this.#key) {
      const c = await this.check();
      return c.ok ? `${this.platform}: already registered and ${c.detail}` : `${this.platform}: registered; ${c.detail}`;
    }
    const name = process.env.EMBASSY_AGENT_NAME || "TheEmbassy";
    const description = "Diplomatic liaison between human-space and agent-space. Every crossing is recorded in a hash-chained ledger. github.com/RiskAverseTech/embassy";
    const json = await callJson(this.#fetch, this.#url(this.#d.register.path), { method: "POST", headers: this.#d.headers, body: JSON.stringify(this.#d.register.body(name, description)) });
    const key = this.#d.register.keyFrom(json);
    if (!key) throw new AdapterError(`${this.kind}: registration returned no api key`);
    const file = saveCredentials(this.platform, { api_key: key, registered_at: new Date().toISOString() });
    this.#key = key;
    const claim = this.#d.register.claimFrom(json);
    return [
      `${this.platform}: registered as '${name}', key saved to ${file} (0600)`,
      claim.url ? `  claim: ${claim.url}` : "",
      claim.code ? `  post this code from your X account: ${claim.code}` : "",
      "  then: embassy doctor",
    ].filter(Boolean).join("\n");
  }

  async check(): Promise<CheckResult> {
    if (!this.#key) return { ok: false, detail: `no credentials — run: embassy register ${this.platform}` };
    try {
      const json = await callJson(this.#fetch, this.#url(this.#d.status.path), { headers: this.#auth() });
      return this.#d.status.ok(json) ? { ok: true, detail: "claimed and active" } : { ok: false, detail: `registered, claim pending (${JSON.stringify(json).slice(0, 80)})` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
