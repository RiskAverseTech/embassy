/**
 * Agent4Science (UChicago CHAI Lab) — a Reddit-style network where agents
 * post "takes" on papers, write peer reviews, and comment; humans observe.
 *
 * Shapes from https://agent4science.org/docs as read on 2026-09-12:
 *   POST /agents/create            { handle, displayName, bio, model, persona } → { agent, apiKey }
 *   GET  /feed?type=all&limit=20   → { papers, takes, reviews }        (auth)
 *   GET  /random                   → { papers, takes, reviews }        (public)
 *   GET  /sciencesubs              → { sciencesubs }
 *   POST /sciencesubs/{slug}/join
 *   POST /takes                    { paperId?, stance, summary[], hotTake }
 *   POST /takes/{id}/comments      { body, intent, parentId? }
 *
 * Channel grammar:
 *   feed                  read  — everything (auth)
 *   feed?type=takes|papers|reviews
 *   random                read  — public sample, no credentials needed
 *   takes                 write — a take; title → hotTake, body → summary[]
 *   takes?stance=<word>   write — same, with an explicit stance
 *
 * Not exercised live from this codebase. The `stance` vocabulary is not
 * documented; the default here is "neutral" and the API will reject it if
 * that is wrong — `doctor` and `--dry-run` are how you find out before a
 * real crossing. Platform rule: an agent must join ≥5 sciencesubs before
 * posting; `setup` joins the first five listed.
 */

import { Edge } from "../charter";
import { Adapter, AdapterContext, AdapterError, CheckResult, DeliveryRef, InboundMessage, NotConfigured, callJson, requireEdge } from "./types";
import { saveCredentials } from "../credentials";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function a4sChannelKind(channel: string): "read" | "write" | null {
  if (/^feed(\?type=(all|takes|papers|reviews))?$/.test(channel) || channel === "random") return "read";
  if (/^takes(\?stance=[a-z_-]{1,32})?$/.test(channel)) return "write";
  return null;
}

export class Agent4ScienceAdapter implements Adapter {
  readonly platform: string;
  readonly kind = "agent4science";
  readonly capabilities: ReadonlySet<"read" | "write" | "reply"> = new Set(["read", "write", "reply"]);
  readonly #base: string;
  readonly #site: string;
  readonly #fetch: typeof fetch;
  #key: string | null;

  constructor(ctx: AdapterContext) {
    this.platform = ctx.platform.id;
    this.#base = ctx.platform.base!.replace(/\/+$/, "");
    this.#site = this.#base.replace(/\/api\/v\d+$/, "");
    this.#fetch = ctx.fetch;
    this.#key = ctx.credentials?.api_key ?? null;
  }

  #auth(): Record<string, string> {
    if (!this.#key) throw new NotConfigured(this.platform, `run: embassy register ${this.platform}`);
    return { Authorization: `Bearer ${this.#key}` };
  }

  #item(kind: "paper" | "take" | "review", raw: any, channel: string): InboundMessage | null {
    const id = str(raw?.id);
    if (!id) return null;
    const title = kind === "take" ? str(raw.hotTake) : str(raw.title);
    const body =
      kind === "take"
        ? [raw.stance ? `stance: ${raw.stance}` : "", ...(Array.isArray(raw.summary) ? raw.summary.map(str) : [str(raw.summary)])].filter(Boolean).join("\n")
        : kind === "review"
          ? [str(raw.summary), raw.strengths?.length ? `strengths: ${raw.strengths.map(str).join("; ")}` : "", raw.weaknesses?.length ? `weaknesses: ${raw.weaknesses.map(str).join("; ")}` : ""].filter(Boolean).join("\n")
          : str(raw.abstract ?? raw.summary ?? raw.body);
    return {
      id: `${kind}:${id}`,
      channel,
      author: str(raw.agent?.handle ?? raw.author?.handle ?? raw.agentHandle ?? raw.author ?? "unknown"),
      title,
      body,
      at: str(raw.createdAt ?? raw.created_at) || new Date().toISOString(),
      url: raw.paperUrl ? str(raw.paperUrl) : `${this.#site}/${kind}s/${id}`,
      signal: Number(raw.score ?? raw.votes ?? raw.upvotes ?? 0) || 0,
    };
  }

  async read(edge: Edge, limit: number = 20): Promise<InboundMessage[]> {
    requireEdge(edge, this.platform);
    if (a4sChannelKind(edge.channel) !== "read") throw new AdapterError(`agent4science: channel '${edge.channel}' is not readable`);
    let json: any;
    if (edge.channel === "random") {
      json = await callJson(this.#fetch, `${this.#base}/random`);
    } else {
      const type = edge.channel.match(/type=(\w+)/)?.[1] ?? "all";
      json = await callJson(this.#fetch, `${this.#base}/feed?type=${type}&limit=${limit}`, { headers: this.#auth() });
    }
    const out: InboundMessage[] = [];
    for (const raw of json?.papers ?? []) { const m = this.#item("paper", raw, edge.channel); if (m) out.push(m); }
    for (const raw of json?.takes ?? []) { const m = this.#item("take", raw, edge.channel); if (m) out.push(m); }
    for (const raw of json?.reviews ?? []) { const m = this.#item("review", raw, edge.channel); if (m) out.push(m); }
    return out.slice(0, limit);
  }

  async write(edge: Edge, title: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    if (a4sChannelKind(edge.channel) !== "write") throw new AdapterError(`agent4science: channel '${edge.channel}' is not writable`);
    const stance = edge.channel.match(/stance=([a-z_-]+)/)?.[1] ?? "neutral";
    const summary = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const json = await callJson(this.#fetch, `${this.#base}/takes`, {
      method: "POST",
      headers: this.#auth(),
      body: JSON.stringify({ stance, summary, hotTake: title || summary[0]?.slice(0, 200) || "Relayed from human-space" }),
    });
    const id = json?.take?.id ?? json?.id;
    if (!id) throw new AdapterError("agent4science: accepted the take but returned no id");
    return { id: String(id), url: `${this.#site}/takes/${id}` };
  }

  async reply(edge: Edge, inReplyTo: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    const takeId = inReplyTo.replace(/^take:/, "");
    const json = await callJson(this.#fetch, `${this.#base}/takes/${encodeURIComponent(takeId)}/comments`, {
      method: "POST",
      headers: this.#auth(),
      body: JSON.stringify({ body, intent: "question" }),
    });
    const id = json?.comment?.id ?? json?.id ?? takeId;
    return { id: String(id), url: `${this.#site}/takes/${takeId}` };
  }

  async setup(): Promise<string> {
    if (this.#key) return `${this.platform}: already registered — ${(await this.check()).detail}`;
    const handle = (process.env.EMBASSY_AGENT_NAME || "TheEmbassy").toLowerCase().replace(/[^a-z0-9_]/g, "");
    const json = await callJson(this.#fetch, `${this.#base}/agents/create`, {
      method: "POST",
      body: JSON.stringify({
        handle,
        displayName: "The Embassy",
        bio: "Diplomatic liaison between human-space and agent-space. Relays human questions in; renders agent discourse out. Every crossing hash-chained. github.com/RiskAverseTech/embassy",
        model: "claude",
        persona: { voice: "measured", epistemics: "flags uncertainty", spiceLevel: "low", petPeeves: ["misattribution"], preferredTopics: ["human-agent relations"], catchphrases: [] },
      }),
    });
    const key = json?.apiKey ?? json?.api_key;
    if (!key) throw new AdapterError("agent4science: creation returned no apiKey");
    const file = saveCredentials(this.platform, { api_key: key, handle, registered_at: new Date().toISOString() });
    this.#key = key;

    // Platform rule: ≥5 sciencesubs before posting. Join the first five.
    let joined = 0;
    try {
      const subs = (await callJson(this.#fetch, `${this.#base}/sciencesubs`))?.sciencesubs ?? [];
      for (const s of subs.slice(0, 5)) {
        const slug = str(s?.slug ?? s?.name);
        if (!slug) continue;
        await callJson(this.#fetch, `${this.#base}/sciencesubs/${encodeURIComponent(slug)}/join`, { method: "POST", headers: this.#auth() });
        joined++;
      }
    } catch { /* leave for the operator; doctor will report */ }
    return `${this.platform}: created '${handle}', key saved to ${file} (0600); joined ${joined} sciencesubs (5 required before posting)`;
  }

  async check(): Promise<CheckResult> {
    try {
      const pub = await callJson(this.#fetch, `${this.#base}/random`);
      const n = (pub?.takes?.length ?? 0) + (pub?.papers?.length ?? 0);
      if (!this.#key) return { ok: false, detail: `public feed reachable (${n} items); no credentials — run: embassy register ${this.platform}` };
      await callJson(this.#fetch, `${this.#base}/feed?type=all&limit=1`, { headers: this.#auth() });
      return { ok: true, detail: `authenticated feed reachable; public sample ${n} items` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
