/**
 * Adapter factory: one instance per Platforms row, keyed by platform alias.
 * The charter names an adapter kind; this is the only place a kind becomes
 * code. `fetch` is injectable so adapters can be tested without a network.
 */

import { Charter, Platform } from "../charter";
import { loadCredentials } from "../credentials";
import { Adapter, AdapterContext, AdapterError } from "./types";
import { ConsoleAdapter, consoleChannelKind } from "./console";
import { MoltAdapter, MOLT_DIALECTS, MOLT_KNOWN_HOSTS, moltChannelKind } from "./molt";
import { Agent4ScienceAdapter, a4sChannelKind } from "./agent4science";
import { A2AAdapter, a2aChannelKind } from "./a2a";
import { DiscordAdapter, discordChannelKind } from "./discord";

/**
 * A known dialect pointed at a host other than its well-known one is refused
 * unless the charter's frontmatter lists the alias under `offhost:` — an
 * explicit, diff-visible opt-in for self-hosted forks. Without it, an alias's
 * per-platform key can never be sent to a lookalike domain.
 */
export function assertKnownHost(platform: Platform, offhost: readonly string[]): void {
  const known = MOLT_KNOWN_HOSTS[platform.adapter];
  if (!known || !platform.base) return;
  const host = new URL(platform.base).hostname;
  if (host !== known && !offhost.includes(platform.id)) {
    throw new AdapterError(
      `platform '${platform.id}' points ${platform.adapter} at ${host}, but that dialect lives at ${known}. ` +
        `If this is a self-hosted fork, add 'offhost: ${platform.id}' to the charter frontmatter.`
    );
  }
}

export function buildAdapter(platform: Platform, opts: { fetch?: typeof fetch; quiet?: boolean; offhost?: readonly string[] } = {}): Adapter {
  assertKnownHost(platform, opts.offhost ?? []);
  const ctx: AdapterContext = { platform, credentials: loadCredentials(platform.id, platform.base), fetch: opts.fetch ?? globalThis.fetch };
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
  return charter.platforms().map((p) => buildAdapter(p, { ...opts, offhost: charter.meta.offhost }));
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
  for (const p of charter.platforms()) {
    try { assertKnownHost(p, charter.meta.offhost); } catch (err) { problems.push((err as Error).message); }
    const known = MOLT_KNOWN_HOSTS[p.adapter];
    if (known && p.base && new URL(p.base).hostname !== known && charter.meta.offhost.includes(p.id)) {
      problems.push(`${p.id}: NOTE — off-host by charter opt-in; its credentials go to ${new URL(p.base).hostname}, not ${known}`);
    }
  }
  for (const e of charter.list()) {
    const p = charter.platform(e.platform);
    const k = channelKind(p.adapter, e.channel);
    if (k === null) { problems.push(`${e.id}: channel '${e.channel}' is not valid for ${p.adapter}`); continue; }
    if (e.readable && k === "write") problems.push(`${e.id}: '${e.channel}' is write-only on ${p.adapter} but the edge is readable`);
    if (e.writable && k === "read") problems.push(`${e.id}: '${e.channel}' is read-only on ${p.adapter} but the edge is writable`);
  }
  return problems;
}
