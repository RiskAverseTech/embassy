/**
 * Discord — the human side, and a bridge target.
 *
 * A bot token reads a channel's recent messages and posts to it. Discord
 * caps a message at 2,000 characters; a longer body is split at paragraph
 * boundaries into consecutive messages, and the provenance footer always
 * rides in the last one. Every chunk id is returned in the delivery ref.
 *
 * Channel grammar: the numeric channel id (17–20 digits). Credentials:
 * { token } from `embassy register <platform>` (paste), or the
 * DISCORD_BOT_TOKEN environment variable as a fallback for secrets only —
 * routing never comes from the environment.
 *
 * Reading other bots' messages requires no special intent; reading message
 * CONTENT at scale requires the Message Content privileged intent once the
 * bot is in 10,000+ servers. A bridge for one community is well under that.
 */

import { Edge } from "../charter";
import { Adapter, AdapterContext, AdapterError, CheckResult, DeliveryRef, InboundMessage, NotConfigured, callJson, requireEdge } from "./types";
import { saveCredentials } from "../credentials";

const API = "https://discord.com/api/v10";
export const DISCORD_MAX = 2000;
const CHANNEL_ID = /^\d{17,20}$/;

export function discordChannelKind(channel: string): "both" | null {
  return CHANNEL_ID.test(channel) ? "both" : null;
}

/** Split at paragraph, then line, then hard boundaries; never mid-word if avoidable. */
export function chunk(text: string, max: number = DISCORD_MAX): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export class DiscordAdapter implements Adapter {
  readonly platform: string;
  readonly kind = "discord";
  readonly capabilities: ReadonlySet<"read" | "write" | "reply"> = new Set(["read", "write", "reply"]);
  readonly #fetch: typeof fetch;
  readonly #base: string;
  #token: string | null;

  constructor(ctx: AdapterContext) {
    this.platform = ctx.platform.id;
    this.#base = ctx.platform.base!.replace(/\/+$/, "");
    if (new URL(this.#base).origin !== "https://discord.com") {
      throw new AdapterError(`discord: base must be https://discord.com/api/v10 (got ${this.#base})`);
    }
    this.#fetch = ctx.fetch;
    this.#token = ctx.credentials?.token ?? process.env.DISCORD_BOT_TOKEN ?? null;
  }

  #auth(): Record<string, string> {
    if (!this.#token) throw new NotConfigured(this.platform, `run: embassy register ${this.platform}`);
    return { Authorization: `Bot ${this.#token}` };
  }

  #channel(edge: Edge): string {
    if (!CHANNEL_ID.test(edge.channel)) throw new AdapterError(`discord: channel '${edge.channel}' must be a numeric channel id`);
    return edge.channel;
  }

  async read(edge: Edge, limit: number = 25): Promise<InboundMessage[]> {
    requireEdge(edge, this.platform);
    const ch = this.#channel(edge);
    const msgs: any[] = await callJson(this.#fetch, `${this.#base}/channels/${ch}/messages?limit=${Math.min(limit, 100)}`, { headers: this.#auth() });
    return (Array.isArray(msgs) ? msgs : [])
      .filter((m) => typeof m?.id === "string" && typeof m?.content === "string")
      .map((m) => ({
        id: m.id,
        channel: ch,
        author: m.author?.global_name || m.author?.username || "unknown",
        title: "",
        body: m.content,
        at: m.timestamp || new Date().toISOString(),
        url: m.guild_id ? `https://discord.com/channels/${m.guild_id}/${ch}/${m.id}` : undefined,
        signal: Array.isArray(m.reactions) ? m.reactions.reduce((n: number, r: any) => n + (r.count ?? 0), 0) : 0,
        inReplyTo: m.message_reference?.message_id,
      }))
      .reverse(); // API returns newest first; the Embassy wants oldest first
  }

  async write(edge: Edge, title: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    const ch = this.#channel(edge);
    const full = title ? `**${title}**\n\n${body}` : body;
    const ids: string[] = [];
    let guild: string | undefined;
    for (const part of chunk(full)) {
      const m = await callJson(this.#fetch, `${this.#base}/channels/${ch}/messages`, {
        method: "POST",
        headers: this.#auth(),
        body: JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
      });
      if (!m?.id) throw new AdapterError("discord: message accepted but no id returned");
      ids.push(m.id);
      guild = guild ?? m.guild_id;
    }
    const last = ids[ids.length - 1];
    return { id: ids.join("+"), url: guild ? `https://discord.com/channels/${guild}/${ch}/${last}` : `discord://${ch}/${last}` };
  }

  async reply(edge: Edge, inReplyTo: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    const ch = this.#channel(edge);
    const parts = chunk(body);
    const ids: string[] = [];
    let guild: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      const m = await callJson(this.#fetch, `${this.#base}/channels/${ch}/messages`, {
        method: "POST",
        headers: this.#auth(),
        body: JSON.stringify({
          content: parts[i],
          allowed_mentions: { parse: [] },
          ...(i === 0 ? { message_reference: { message_id: inReplyTo } } : {}),
        }),
      });
      ids.push(m.id);
      guild = guild ?? m.guild_id;
    }
    return { id: ids.join("+"), url: guild ? `https://discord.com/channels/${guild}/${ch}/${ids[0]}` : `discord://${ch}/${ids[0]}` };
  }

  async setup(): Promise<string> {
    if (this.#token) return `${this.platform}: token present — ${(await this.check()).detail}`;
    const token = process.env.EMBASSY_DISCORD_TOKEN;
    if (!token) {
      return [
        `${this.platform}: needs a bot token.`,
        "  1. https://discord.com/developers/applications → New Application → Bot → Reset Token",
        "  2. Invite the bot to your server with Send Messages + Read Message History",
        `  3. EMBASSY_DISCORD_TOKEN=<token> embassy register ${this.platform}`,
      ].join("\n");
    }
    const file = saveCredentials(this.platform, { token, registered_at: new Date().toISOString() });
    this.#token = token;
    return `${this.platform}: token saved to ${file} (0600) — ${(await this.check()).detail}`;
  }

  async check(): Promise<CheckResult> {
    if (!this.#token) return { ok: false, detail: `no token — run: embassy register ${this.platform}` };
    try {
      const me = await callJson(this.#fetch, `${this.#base}/users/@me`, { headers: this.#auth() });
      return { ok: true, detail: `bot '${me?.username ?? "?"}' authenticated` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
