/**
 * Adapter factory: one instance per Platforms row, keyed by platform alias.
 * The charter names an adapter kind; this is the only place a kind becomes
 * code. `fetch` is injectable so adapters can be tested without a network.
 */

import { Charter, Platform } from "../charter";
import { loadCredentials } from "../credentials";
import { Adapter, AdapterContext, AdapterError } from "./types";
import { ConsoleAdapter, consoleChannelKind } from "./console";
import { MoltAdapter, MOLT_DIALECTS, moltChannelKind } from "./molt";
import { Agent4ScienceAdapter, a4sChannelKind } from "./agent4science";
import { A2AAdapter, a2aChannelKind } from "./a2a";
import { DiscordAdapter, discordChannelKind } from "./discord";

export function buildAdapter(platform: Platform, opts: { fetch?: typeof fetch; quiet?: boolean } = {}): Adapter {
  const ctx: AdapterContext = { platform, credentials: loadCredentials(platform.id), fetch: opts.fetch ?? globalThis.fetch };
  switch (platform.adapter) {
    case "console": return new ConsoleAdapter({ platform, credentials: null, fetch: ctx.fetch, ...(opts.quiet ? { quiet: true } : {}) } as any);
    case "agent4science": return new Agent4ScienceAdapter(ctx);
    case "a2a": return new A2AAdapter(ctx);
    case "discord": return new DiscordAdapter(ctx);
    default:
      if (MOLT_DIALECTS.includes(platform.adapter)) return new MoltAdapter(ctx);
      throw new AdapterError(`no adapter implementation for kind '${platform.adapter}'`);
  }
}

export function buildAdapters(charter: Charter, opts: { fetch?: typeof fetch; quiet?: boolean } = {}): Adapter[] {
  return charter.platforms().map((p) => buildAdapter(p, opts));
}

/** Pure, network-free: does this channel string parse for this adapter kind, and in which direction? */
export function channelKind(kind: string, channel: string): "read" | "write" | "both" | null {
  if (kind === "console") return consoleChannelKind(channel);
  if (kind === "agent4science") return a4sChannelKind(channel);
  if (kind === "a2a") return a2aChannelKind(channel);
  if (kind === "discord") return discordChannelKind(channel);
  return moltChannelKind(kind, channel);
}

/** Lint every edge against its adapter's channel grammar and role. Returns problems; empty means clean. */
export function lintCharter(charter: Charter): string[] {
  const problems: string[] = [];
  for (const e of charter.list()) {
    const p = charter.platform(e.platform);
    const k = channelKind(p.adapter, e.channel);
    if (k === null) { problems.push(`${e.id}: channel '${e.channel}' is not valid for ${p.adapter}`); continue; }
    if (e.readable && k === "write") problems.push(`${e.id}: '${e.channel}' is write-only on ${p.adapter} but the edge is readable`);
    if (e.writable && k === "read") problems.push(`${e.id}: '${e.channel}' is read-only on ${p.adapter} but the edge is writable`);
  }
  return problems;
}
