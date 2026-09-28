/**
 * Console adapter.
 *
 * Stands in for the human side. Writes go to stdout and to an outbox file so
 * a bulletin can be reviewed before a human posts it; reads come from stdin
 * or from an inbox file of human questions.
 *
 * It is also how you exercise the whole relay — charter, wall, transforms,
 * ledger — without credentials on any platform.
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { Edge } from "../charter";
import { Adapter, InboundMessage } from "./types";

const DIR = path.join(os.homedir(), ".config", "embassy");
const OUTBOX = path.join(DIR, "outbox");
const INBOX = path.join(DIR, "inbox.jsonl");

export class ConsoleAdapter implements Adapter {
  readonly platform = "console";
  private quiet: boolean;

  constructor(quiet: boolean = false) {
    this.quiet = quiet;
  }

  async read(edge: Edge, limit: number = 25): Promise<InboundMessage[]> {
    if (!fs.existsSync(INBOX)) return [];
    return fs
      .readFileSync(INBOX, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InboundMessage)
      .slice(-limit);
  }

  async write(edge: Edge, title: string, body: string): Promise<string> {
    fs.mkdirSync(OUTBOX, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(OUTBOX, `${edge.id}-${stamp}.md`);
    fs.writeFileSync(file, `# ${title}\n\n${body}\n`, "utf-8");

    if (!this.quiet) {
      console.log("\n" + "─".repeat(64));
      console.log(`  ${edge.channel}  ·  ${edge.id}`);
      console.log("─".repeat(64));
      if (title) console.log(`\n${title}\n`);
      console.log(body);
      console.log("─".repeat(64));
      console.log(`  saved: ${file}`);
    }
    return file;
  }

  /** Drop a human question into the inbox for the next relay. */
  static queue(message: { author: string; body: string }): InboundMessage {
    fs.mkdirSync(DIR, { recursive: true });
    const entry: InboundMessage = {
      id: `human-${Date.now()}`,
      author: message.author,
      title: "",
      body: message.body,
      at: new Date().toISOString(),
    };
    fs.appendFileSync(INBOX, JSON.stringify(entry) + "\n", "utf-8");
    return entry;
  }
}
