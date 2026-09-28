/**
 * Console adapter.
 *
 * Stands in for the human side. Writes go to an outbox file (and stdout) so
 * a bulletin can be reviewed before a human posts it; reads come from an
 * inbox file named by the edge's channel, so two console listen edges are
 * two separate inboxes.
 *
 * It is also how you exercise the whole relay — charter, wall, transforms,
 * ledger — without credentials on any platform.
 */

import fs from "fs";
import path from "path";
import { Edge } from "../charter";
import { Adapter, AdapterContext, AdapterError, CheckResult, DeliveryRef, InboundMessage, requireEdge } from "./types";
import { configDir } from "../credentials";

const DIR = () => configDir();
const OUTBOX = () => path.join(DIR(), "outbox");

const CHANNEL = /^[a-z0-9@][a-z0-9@._-]{0,63}$/i;

function inboxFor(platform: string, channel: string): string {
  if (!CHANNEL.test(channel)) throw new AdapterError(`console channel '${channel}' is not a valid inbox name`);
  return path.join(DIR(), `inbox.${platform}.${channel.replace(/^@/, "")}.jsonl`);
}

export function consoleChannelKind(channel: string): "both" | null {
  return CHANNEL.test(channel) ? "both" : null;
}

export class ConsoleAdapter implements Adapter {
  readonly platform: string;
  readonly kind = "console";
  readonly capabilities = new Set<"read" | "write" | "reply">(["read", "write"]);
  #quiet: boolean;

  constructor(ctx: AdapterContext | { platform?: string; quiet?: boolean } = {}) {
    this.platform = "platform" in ctx && ctx.platform && typeof ctx.platform === "object" ? ctx.platform.id : (ctx as any).platform ?? "console";
    this.#quiet = (ctx as any).quiet ?? false;
  }

  async check(): Promise<CheckResult> {
    return { ok: true, detail: `outbox ${OUTBOX()}` };
  }

  async read(edge: Edge, limit: number = 25): Promise<InboundMessage[]> {
    requireEdge(edge, this.platform);
    const file = inboxFor(edge.platform, edge.channel);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InboundMessage)
      .slice(-limit);
  }

  async write(edge: Edge, title: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    if (!CHANNEL.test(edge.channel)) throw new AdapterError(`console channel '${edge.channel}' is not valid`);

    fs.mkdirSync(OUTBOX(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(OUTBOX(), `${edge.id}-${stamp}.md`);
    fs.writeFileSync(file, `# ${title}\n\n${body}\n`, "utf-8");

    if (!this.#quiet) {
      console.log("\n" + "─".repeat(64));
      console.log(`  ${edge.channel}  ·  ${edge.id}`);
      console.log("─".repeat(64));
      if (title) console.log(`\n${title}\n`);
      console.log(body);
      console.log("─".repeat(64));
      console.log(`  saved: ${file}`);
    }
    return { id: path.basename(file, ".md"), url: file };
  }

  /** Drop a human message into a console edge's inbox for the next relay. */
  static queue(edge: Edge, message: { author: string; body: string }): InboundMessage {
    if (!Edge.is(edge)) throw new AdapterError("queue() needs a charter-minted Edge");
    fs.mkdirSync(DIR(), { recursive: true });
    const entry: InboundMessage = {
      id: `human-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      channel: edge.channel,
      author: message.author,
      title: "",
      body: message.body,
      at: new Date().toISOString(),
    };
    fs.appendFileSync(inboxFor(edge.platform, edge.channel), JSON.stringify(entry) + "\n", "utf-8");
    return entry;
  }
}
