/**
 * The relay.
 *
 * Reads from mapped inbound edges, renders through the transform the
 * destination declares, writes to mapped outbound edges, and records every
 * crossing in the ledger.
 *
 * The relay holds no policy of its own. Everything it is allowed to do comes
 * from the charter, and everything it did is in the ledger.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Charter, Edge, ScopeViolation } from "./charter";
import { Ledger, Crossing } from "./ledger";
import { getTransform, loadSoul, TransformContext } from "./transforms";
import { Adapter, InboundMessage, NoAdapter } from "./adapters/types";

export interface RelayResult {
  crossing: Crossing;
  delivered: string;
}

export class RateExceeded extends Error {
  constructor(edge: Edge, used: number) {
    super(
      `'${edge.id}' is at its charter rate (${used}/${edge.rate!.count} per ${edge.rate!.per}) — nothing sent`
    );
    this.name = "RateExceeded";
  }
}

export class Embassy {
  charter: Charter;
  readonly ledger: Ledger;
  private adapters: Map<string, Adapter>;
  private anthropic: Anthropic;
  private soul: string;

  constructor(charter: Charter, adapters: Adapter[], ledger: Ledger = new Ledger()) {
    this.charter = charter;
    this.ledger = ledger;
    this.adapters = new Map(adapters.map((a) => [a.platform, a]));
    this.anthropic = new Anthropic();
    this.soul = loadSoul();
  }

  /** Re-read the charter without restarting. Wired to SIGHUP by the CLI. */
  reloadCharter(): void {
    this.charter = this.charter.reload();
  }

  private adapterFor(edge: Edge): Adapter {
    const adapter = this.adapters.get(edge.platform);
    if (!adapter) throw new NoAdapter(edge.platform, [...this.adapters.keys()]);
    return adapter;
  }

  private ctx(note?: string): TransformContext {
    return { soul: this.soul, anthropic: this.anthropic, note };
  }

  /** Read from an inbound edge. Throws if the charter does not permit it. */
  async collect(edgeId: string, limit: number = 25): Promise<InboundMessage[]> {
    const edge = this.charter.assertReadable(edgeId);
    return this.adapterFor(edge).read(edge, limit);
  }

  /**
   * One crossing, end to end.
   *
   * Order matters: the wall is checked before the model is called, so a
   * disallowed crossing costs nothing and leaves no trace of the content
   * anywhere it should not be.
   */
  async relay(
    fromId: string,
    toId: string,
    source: string,
    title: string = ""
  ): Promise<RelayResult> {
    const { from, to, transform } = this.charter.assertCrossing(fromId, toId);

    if (to.rate) {
      const used = this.ledger.countWithin(to.id, to.rate);
      if (used >= to.rate.count) throw new RateExceeded(to, used);
    }

    const render = getTransform(transform);
    const rendered = await render(source, this.ctx(`${from.id} → ${to.id}`));

    if (!rendered.trim()) {
      throw new Error(`transform '${transform}' produced nothing for ${from.id} → ${to.id}`);
    }

    // Record before delivering, so nothing can be sent that is not in the
    // ledger. A delivery failure leaves a crossing marked undelivered.
    const crossing = this.ledger.record({
      from: from.id,
      to: to.id,
      transform,
      source,
      rendered,
    });

    const body =
      this.charter.meta.provenance === "required"
        ? `${rendered}\n\n---\n*Relayed by The Embassy · crossing \`${crossing.id}\` · ` +
          `${from.id} → ${to.id} via \`${transform}\` · ` +
          `verify: \`embassy verify ${crossing.id}\`*`
        : rendered;

    const delivered = await this.adapterFor(to).write(to, title, body);
    return { crossing, delivered };
  }

  /**
   * Gather everything new on the inbound edges that route to `toId`, and
   * relay it as one crossing.
   */
  async sweep(fromIds: string[], toId: string, title: string): Promise<RelayResult | null> {
    const seen = new Set(
      this.ledger
        .all()
        .flatMap((c) => c.source.match(/\[src:([^\]]+)\]/g) ?? [])
    );

    const collected: InboundMessage[] = [];
    for (const fromId of fromIds) {
      for (const message of await this.collect(fromId)) {
        const tag = `[src:${message.id}]`;
        if (!seen.has(tag)) {
          seen.add(tag);
          collected.push(message);
        }
      }
    }

    if (!collected.length) return null;

    const source = collected
      .map(
        (m) =>
          `[src:${m.id}] ${m.title || "(untitled)"} — ${m.author}` +
          (m.signal ? ` (${m.signal}↑)` : "") +
          `\n${m.body.slice(0, 800)}`
      )
      .join("\n\n---\n\n");

    return this.relay(fromIds[0], toId, source, title);
  }
}

export { ScopeViolation };
