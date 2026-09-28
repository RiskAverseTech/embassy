/**
 * The relay.
 *
 * Reads from mapped inbound edges, renders through the transform the
 * destination declares, records the crossing, delivers, records the
 * delivery. The relay holds no policy of its own: everything it is allowed
 * to do comes from the charter, and everything it did is in the ledger.
 *
 * Order inside one crossing, and why:
 *
 *   1. wall        — assertCrossing; a disallowed crossing costs nothing
 *   2. lock        — one crossing at a time per ledger, across processes
 *   3. rate        — counted against the ledger, inside the lock (no TOCTOU)
 *   4. render      — the model runs only after 1–3 pass
 *   5. record      — crossing entry, with the exact body about to be sent
 *   6. deliver     — adapter write
 *   7. record      — delivery entry: ok + ref, or failure + error
 *   8. unlock
 *
 * A failure at 6 leaves a crossing with no successful delivery; its sources
 * are not marked seen, so the next sweep picks them up again, and
 * `redeliver <id>` can resend the same recorded body.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Charter, Edge, ScopeViolation } from "./charter";
import { Ledger, LedgerLocked, CrossingEntry, DeliveryEntry, crossingId, sha } from "./ledger";
import { getTransform, loadSoul, stripFooterLines, PROMPT_VERSION, Transform, TransformContext, TRANSFORMS } from "./transforms";
import { Adapter, DeliveryRef, InboundMessage, NoAdapter } from "./adapters/types";

const ANTHROPIC_DEFAULT = "https://api.anthropic.com";

export interface RelayResult {
  crossing: CrossingEntry;
  delivery: DeliveryEntry | null;
  dryRun: boolean;
}

export interface EmbassyOptions {
  ledger?: Ledger;
  transforms?: Readonly<Record<string, Transform>>;
  anthropic?: Anthropic;
  soul?: string;
  dryRun?: boolean;
}

export class RateExceeded extends Error {
  constructor(edge: Edge, used: number) {
    super(`'${edge.id}' is at its charter rate (${used}/${edge.rate!.count} per ${edge.rate!.per}) — nothing sent`);
    this.name = "RateExceeded";
  }
}

export class Embassy {
  readonly #charter: Charter;
  readonly ledger: Ledger;
  readonly dryRun: boolean;
  readonly #adapters: Map<string, Adapter>;
  readonly #transforms: Readonly<Record<string, Transform>>;
  readonly #anthropic: Anthropic;
  readonly #soul: string;
  readonly soulHash: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(charter: Charter, adapters: Adapter[], opts: EmbassyOptions = {}) {
    this.#charter = charter;
    this.ledger = opts.ledger ?? new Ledger();
    this.dryRun = opts.dryRun ?? false;
    this.#adapters = new Map(adapters.map((a) => [a.platform, a]));
    this.#transforms = opts.transforms ?? TRANSFORMS;
    this.#soul = opts.soul ?? loadSoul();
    this.soulHash = sha(this.#soul);
    // The endpoint is charter-governed, not environment-governed: an env var
    // cannot silently redirect every rendering to another server.
    this.#anthropic =
      opts.anthropic ?? new Anthropic({ baseURL: charter.meta.endpoint ?? ANTHROPIC_DEFAULT });

    for (const edge of charter.list()) {
      if (!this.#adapters.has(edge.platform)) {
        throw new NoAdapter(edge.platform, [...this.#adapters.keys()]);
      }
    }
  }

  get charter(): Charter {
    return this.#charter;
  }

  /**
   * Record the charter AND constitution in force (sha256 of each, plus edge
   * ids) if either differs from the last recorded. Call once on open. This is
   * what makes a charter edit, a SOUL.md edit, or an EMBASSY_HOME
   * substitution of either, visible in the audit trail.
   */
  async noteCharter(): Promise<boolean> {
    if (this.dryRun) return false;
    return this.ledger.withLock(async () => {
      const last = this.ledger.lastCharter();
      if (last && last.charterHash === this.#charter.hash && last.soulHash === this.soulHash) return false;
      this.ledger.recordCharter(this.#charter.hash, this.soulHash, this.#charter.list().map((e) => `${e.id}=${e.platform}:${e.channel}:${e.role}/${e.direction}`));
      return true;
    });
  }

  #adapterFor(edge: Edge): Adapter {
    const adapter = this.#adapters.get(edge.platform);
    if (!adapter) throw new NoAdapter(edge.platform, [...this.#adapters.keys()]);
    return adapter;
  }

  #ctx(to?: Edge): TransformContext {
    const limit = to ? (this.#adapterFor(to) as Adapter & { maxBody?: number | null }).maxBody ?? undefined : undefined;
    // Leave room for the provenance footer (~160 chars) when a limit applies.
    const maxChars = typeof limit === "number" ? Math.max(80, limit - (this.#charter.meta.provenance === "required" ? 170 : 0)) : undefined;
    return { soul: this.#soul, model: this.#charter.meta.model, anthropic: this.#anthropic, maxChars };
  }

  /** Serialize crossings within this process; the file lock serializes across processes. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #footer(id: string, from: Edge[], to: Edge, transform: string): string {
    const anchor = this.ledger.head();
    return (
      `\n\n---\n*Relayed by The Embassy · crossing \`${id}\` · ` +
      `${from.map((f) => f.id).join("+")} → ${to.id} via \`${transform}\` · ` +
      `ledger #${anchor.seq} ${anchor.hash.slice(0, 12)}*`
    );
  }

  /** Read from an inbound edge. Throws if the charter does not permit it. */
  async collect(edgeId: string, limit: number = 25): Promise<InboundMessage[]> {
    const edge = this.#charter.assertReadable(edgeId);
    return this.#adapterFor(edge).read(edge, limit);
  }

  /** One crossing, end to end. */
  async relay(fromIds: string[], toId: string, source: string, opts: { title?: string; sources?: string[] } = {}): Promise<RelayResult> {
    const { from, to, transform } = this.#charter.assertCrossing(fromIds, toId);
    const render = getTransform(transform, this.#transforms);

    return this.#serial(() =>
      this.ledger.withLock(async () => {
        if (to.rate) {
          const used = this.ledger.countWithin(to.id, to.rate);
          if (used >= to.rate.count) throw new RateExceeded(to, used);
        }

        // The source is recorded exactly as received — never filtered. Only
        // the OUTPUT of an LLM transform is filtered for footer impostors
        // (a model can echo one), and the count is recorded so the filtering
        // is never silent. `verbatim` is delivered exactly as received.
        const raw = (await render(source, this.#ctx(to))).trim();
        const rendered = transform === "verbatim" ? raw : stripFooterLines(raw);
        const strippedLines = transform === "verbatim" ? 0 : raw.split("\n").length - rendered.split("\n").length;
        if (!rendered) throw new Error(`transform '${transform}' produced nothing for ${fromIds.join("+")} → ${to.id}`);

        const id = crossingId();
        const body = this.#charter.meta.provenance === "required"
          ? rendered + this.#footer(id, from, to, transform)
          : rendered;
        const title = opts.title ?? "";

        if (this.dryRun) {
          const preview: CrossingEntry = {
            schema: 2, kind: "crossing", seq: 0, prev: "", hash: "", anchor: this.ledger.head(),
            id, at: new Date().toISOString(), from: from.map((f) => f.id), to: to.id, transform,
            model: this.#charter.meta.model, promptVersion: PROMPT_VERSION, soulHash: this.soulHash, strippedLines,
            sources: opts.sources ?? [], title, source, sourceHash: "", rendered, body, bodyHash: "",
          };
          return { crossing: preview, delivery: null, dryRun: true };
        }

        const crossing = this.ledger.recordCrossing({
          id, from: from.map((f) => f.id), to: to.id, transform,
          model: this.#charter.meta.model, promptVersion: PROMPT_VERSION, soulHash: this.soulHash, strippedLines,
          sources: opts.sources ?? [], title, source, rendered, body,
        });

        const delivery = await this.#deliver(crossing, to);
        return { crossing, delivery, dryRun: false };
      })
    );
  }

  async #deliver(crossing: CrossingEntry, to: Edge): Promise<DeliveryEntry> {
    let ref: DeliveryRef;
    try {
      ref = await this.#adapterFor(to).write(to, crossing.title, crossing.body);
    } catch (err) {
      const delivery = this.ledger.recordDelivery(crossing.id, { ok: false, error: (err as Error).message });
      throw Object.assign(err as Error, { crossing, delivery });
    }
    return this.ledger.recordDelivery(crossing.id, { ok: true, ref: ref.url });
  }

  /** Resend a recorded crossing's exact body. No re-render, no new crossing. */
  async redeliver(id: string): Promise<DeliveryEntry> {
    const crossing = this.ledger.find(id);
    if (!crossing) throw new Error(`no crossing '${id}'`);
    if (this.ledger.deliveryOf(id)) throw new Error(`crossing '${id}' was already delivered`);
    const to = this.#charter.assertWritable(crossing.to);
    return this.#serial(() => this.ledger.withLock(() => this.#deliver(crossing, to)));
  }

  /**
   * Run a named route from the charter. If `text` is given and the route's
   * first source is a console inbox, the text is queued there first — this
   * is how a human question enters: `embassy run ask "…"`.
   */
  async run(routeId: string, text?: string): Promise<RelayResult | null> {
    const route = this.#charter.route(routeId);
    if (text) {
      const first = this.#charter.assertReadable(route.from[0]);
      if (this.#charter.platform(first.platform).adapter !== "console") {
        throw new ScopeViolation(`route '${routeId}' does not start at a console inbox; text can only be queued into console edges`);
      }
      const { ConsoleAdapter } = await import("./adapters/console");
      ConsoleAdapter.queue(first, { author: "human", body: text });
    }
    return this.sweep([...route.from], route.to, route.title);
  }

  /**
   * Gather everything not yet delivered from the inbound edges, and relay
   * it as one crossing. Sources are tracked by id in the ledger, not by
   * pattern-matching the text.
   */
  async sweep(fromIds: string[], toId: string, title: string): Promise<RelayResult | null> {
    this.#charter.assertCrossing(fromIds, toId);
    const seen = this.ledger.deliveredSources();

    const collected: InboundMessage[] = [];
    for (const fromId of fromIds) {
      for (const m of await this.collect(fromId)) {
        if (!seen.has(m.id)) { seen.add(m.id); collected.push(m); }
      }
    }
    if (!collected.length) return null;

    const source = collected
      .map((m) =>
        `## ${m.title || "(untitled)"}\n` +
        `author: ${m.author} · channel: ${m.channel}` + (m.signal ? ` · ${m.signal}↑` : "") + (m.url ? ` · ${m.url}` : "") +
        `\n\n${m.body.slice(0, 800)}`
      )
      .join("\n\n---\n\n");

    return this.relay(fromIds, toId, source, { title, sources: collected.map((m) => m.id) });
  }
}

export { ScopeViolation, LedgerLocked };
export type { Adapter, DeliveryRef, InboundMessage };
