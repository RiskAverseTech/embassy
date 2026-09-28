/**
 * A2A (Agent2Agent, Linux Foundation) — request/response between agents.
 *
 * A2A is not a feed. An agent publishes an Agent Card at
 * `/.well-known/agent-card.json`; you send it a message with JSON-RPC
 * `message/send`; it answers with a Message or a Task carrying artifacts.
 * To fit the Embassy's read/write model without pretending otherwise:
 *
 *   write(edge)  — channel `send`: send the body as a message; the peer's
 *                  reply is appended to a local inbox for this platform.
 *   read(edge)   — channel `replies`: drain that inbox. So a route
 *                  `human.inbox → peer.send` followed by
 *                  `peer.replies → human.bulletin` is a full round trip,
 *                  every leg recorded.
 *
 * One Platforms row per peer (base = the peer's origin). Optional bearer
 * token in credentials as `token`. Spec references: A2A v1.0 message/send
 * and Agent Card discovery; v0.2 part shape (`type`) is also accepted.
 * Verified against a local A2A server in the test suite, not against a
 * live peer.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Edge } from "../charter";
import { Adapter, AdapterContext, AdapterError, CheckResult, DeliveryRef, InboundMessage, callJson, requireEdge } from "./types";
import { configDir } from "../credentials";

export function a2aChannelKind(channel: string): "read" | "write" | null {
  if (channel === "send") return "write";
  if (channel === "replies") return "read";
  return null;
}

interface AgentCard { name?: string; version?: string; url?: string; skills?: unknown[]; protocolVersion?: string }

function textOf(parts: any[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && (p.kind === "text" || p.type === "text") && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export class A2AAdapter implements Adapter {
  readonly platform: string;
  readonly kind = "a2a";
  readonly capabilities: ReadonlySet<"read" | "write" | "reply"> = new Set(["read", "write"]);
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #token: string | null;
  readonly #inbox: string;
  #card: (AgentCard & { url: string }) | null = null;

  constructor(ctx: AdapterContext) {
    this.platform = ctx.platform.id;
    this.#base = ctx.platform.base!.replace(/\/+$/, "");
    this.#fetch = ctx.fetch;
    this.#token = ctx.credentials?.token ?? null;
    this.#inbox = path.join(configDir(), "a2a", `${ctx.platform.id}.jsonl`);
  }

  #headers(): Record<string, string> {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }

  async #resolveCard(): Promise<AgentCard & { url: string }> {
    if (this.#card) return this.#card;
    const card: AgentCard = await callJson(this.#fetch, `${this.#base}/.well-known/agent-card.json`, { headers: this.#headers() });
    const url = typeof card?.url === "string" ? card.url : `${this.#base}/`;
    // The card may point anywhere; the wall only approved this platform's origin.
    if (new URL(url).origin !== new URL(this.#base).origin) {
      throw new AdapterError(`a2a: agent card for '${this.platform}' points its endpoint at ${new URL(url).origin}, not the charter's ${new URL(this.#base).origin} — refused`);
    }
    this.#card = { ...card, url };
    return this.#card;
  }

  async read(edge: Edge, limit: number = 25): Promise<InboundMessage[]> {
    requireEdge(edge, this.platform);
    if (a2aChannelKind(edge.channel) !== "read") throw new AdapterError(`a2a: channel '${edge.channel}' is not readable — use 'replies'`);
    if (!fs.existsSync(this.#inbox)) return [];
    return fs.readFileSync(this.#inbox, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as InboundMessage).slice(-limit);
  }

  async write(edge: Edge, title: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    if (a2aChannelKind(edge.channel) !== "write") throw new AdapterError(`a2a: channel '${edge.channel}' is not writable — use 'send'`);
    const card = await this.#resolveCard();
    const messageId = crypto.randomUUID();
    const text = title ? `${title}\n\n${body}` : body;

    const rpc = await callJson(this.#fetch, card.url, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: messageId,
        method: "message/send",
        params: { message: { role: "user", messageId, kind: "message", parts: [{ kind: "text", text }] } },
      }),
    });
    if (rpc?.error) throw new AdapterError(`a2a: ${card.name ?? this.platform} returned error ${rpc.error.code}: ${rpc.error.message}`);

    const result = rpc?.result ?? {};
    const taskId = String(result.id ?? result.taskId ?? messageId);
    const replyText =
      result.kind === "message" || result.role
        ? textOf(result.parts)
        : [textOf(result.status?.message?.parts), ...(result.artifacts ?? []).map((a: any) => textOf(a.parts))].filter(Boolean).join("\n\n");

    if (replyText) {
      fs.mkdirSync(path.dirname(this.#inbox), { recursive: true, mode: 0o700 });
      const msg: InboundMessage = {
        id: `${taskId}:${crypto.randomBytes(3).toString("hex")}`,
        channel: "replies",
        author: card.name ?? this.platform,
        title: "",
        body: replyText,
        at: new Date().toISOString(),
        url: card.url,
        inReplyTo: messageId,
      };
      fs.appendFileSync(this.#inbox, JSON.stringify(msg) + "\n", "utf-8");
    }
    return { id: taskId, url: `${card.url}#${taskId}` };
  }

  async check(): Promise<CheckResult> {
    try {
      const card = await this.#resolveCard();
      return { ok: true, detail: `agent card ok — ${card.name ?? "unnamed"} v${card.version ?? "?"}, ${Array.isArray(card.skills) ? card.skills.length : 0} skills, endpoint ${card.url}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
