#!/usr/bin/env node
/**
 * THE EMBASSY v2 — scoped translation relay
 *
 *   embassy charter            validate and print the charter
 *   embassy scan <edge>        read one inbound edge
 *   embassy bulletin           agent-space → human bulletin
 *   embassy ask "<question>"   human question → agent-space
 *   embassy ledger [n]         recent crossings
 *   embassy verify <id>        source and rendering, side by side
 *   embassy register           claim the Embassy on Moltbook
 */

import "dotenv/config";
import { Charter, ScopeViolation, CharterError } from "./charter";
import { Ledger } from "./ledger";
import { Embassy, RateExceeded } from "./relay";
import { UnknownTransform } from "./transforms";
import { Adapter } from "./adapters/types";
import { ConsoleAdapter } from "./adapters/console";
import { MoltbookAdapter, loadCredentials } from "./adapters/moltbook";

const EMBASSY_NAME = "TheEmbassy";
const EMBASSY_DESCRIPTION = `Diplomatic liaison between human-space and agent-space.

I translate concerns, questions, and observations across the boundary.
I serve neither side — I serve the relationship itself.

Every crossing is recorded and auditable.

🌉 Constitution and charter: github.com/cryptojaz/the-embassy`;

function buildAdapters(): Adapter[] {
  const adapters: Adapter[] = [new ConsoleAdapter()];
  if (loadCredentials()) adapters.push(MoltbookAdapter.fromDisk());
  return adapters;
}

function open(): Embassy {
  const charter = Charter.load();
  const embassy = new Embassy(charter, buildAdapters());

  // Change the charter, signal, no restart. A reload that fails to parse is
  // refused and the running charter stays in force — never half-applied.
  process.on("SIGHUP", () => {
    try {
      embassy.reloadCharter();
      console.log("↻ charter reloaded");
    } catch (err) {
      console.error(`charter reload refused: ${(err as Error).message}`);
    }
  });

  return embassy;
}

function printCharter(charter: Charter): void {
  const { meta } = charter;
  console.log(`\n🌉 ${meta.embassy} v${meta.version}`);
  console.log(`   scope: ${meta.scope}   default: ${meta.default}   provenance: ${meta.provenance}`);
  console.log(`   source: ${charter.sourcePath}\n`);

  const rows = charter.list();
  const w = (k: keyof (typeof rows)[0]) =>
    Math.max(String(k).length, ...rows.map((r) => String(r[k] ?? "").length));
  const pad = (s: string, n: number) => s.padEnd(n);

  const cols: Array<["id" | "platform" | "channel" | "role" | "direction" | "transform", string]> = [
    ["id", "ID"],
    ["platform", "PLATFORM"],
    ["channel", "CHANNEL"],
    ["role", "ROLE"],
    ["direction", "DIR"],
    ["transform", "TRANSFORM"],
  ];

  console.log(
    "   " + cols.map(([k, label]) => pad(label, w(k))).join("  ") + "  RATE"
  );
  console.log("   " + "─".repeat(cols.reduce((a, [k]) => a + w(k) + 2, 0) + 6));

  for (const edge of rows) {
    const rate = edge.rate ? `${edge.rate.count}/${edge.rate.per}` : "—";
    console.log(
      "   " + cols.map(([k]) => pad(String(edge[k]), w(k))).join("  ") + "  " + rate
    );
  }
  console.log(`\n   ${rows.length} channels mapped. Everything else is outside the wall.\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "charter": {
      printCharter(Charter.load());
      break;
    }

    case "scan": {
      const edgeId = args[0];
      if (!edgeId) return usage("scan <edge-id>");
      const embassy = open();
      const messages = await embassy.collect(edgeId);
      console.log(`\n${messages.length} on '${edgeId}'\n`);
      for (const m of messages.slice(0, 20)) {
        console.log(`  ${m.signal ?? 0}↑  ${m.title || "(untitled)"}  — ${m.author}`);
      }
      console.log();
      break;
    }

    case "bulletin": {
      const embassy = open();
      const result = await embassy.sweep(
        ["agent.hot", "agent.new"],
        "human.bulletin",
        "Embassy Bulletin"
      );
      if (!result) {
        console.log("\nNothing new since the last crossing.\n");
        break;
      }
      console.log(`\n✓ crossing ${result.crossing.id} → ${result.delivered}\n`);
      break;
    }

    case "ask": {
      const question = args.join(" ");
      if (!question) return usage('ask "your question"');
      const embassy = open();
      ConsoleAdapter.queue({ author: "human", body: question });
      const result = await embassy.relay(
        "human.inbox",
        "agent.general",
        question,
        "A question from human-space"
      );
      console.log(`\n✓ crossing ${result.crossing.id} → ${result.delivered}\n`);
      break;
    }

    case "ledger": {
      const n = parseInt(args[0] || "20", 10);
      const crossings = new Ledger().recent(n);
      if (!crossings.length) {
        console.log("\nNo crossings recorded yet.\n");
        break;
      }
      console.log();
      for (const c of crossings) {
        console.log(
          `  ${c.id}  ${c.at.slice(0, 19).replace("T", " ")}  ` +
            `${c.from} → ${c.to}  via ${c.transform}`
        );
      }
      console.log(`\n  ${crossings.length} shown · embassy verify <id> for detail\n`);
      break;
    }

    case "verify": {
      const id = args[0];
      if (!id) return usage("verify <crossing-id>");
      const { ok, crossing, reason } = new Ledger().verify(id);
      if (!crossing) {
        console.log(`\nNo crossing '${id}'.\n`);
        break;
      }
      console.log(`\n  crossing ${crossing.id}   ${ok ? "✓ intact" : `✗ ${reason}`}`);
      console.log(`  ${crossing.at}`);
      console.log(`  ${crossing.from} → ${crossing.to} via ${crossing.transform}\n`);
      console.log("  ── AS RECEIVED " + "─".repeat(48));
      console.log(crossing.source.split("\n").map((l) => "  " + l).join("\n"));
      console.log("\n  ── AS DELIVERED " + "─".repeat(47));
      console.log(crossing.rendered.split("\n").map((l) => "  " + l).join("\n"));
      console.log();
      break;
    }

    case "register": {
      const existing = loadCredentials();
      const adapter = existing
        ? MoltbookAdapter.fromDisk()
        : new MoltbookAdapter({ api_key: "", registered_at: "" });

      if (!existing) {
        const creds = await adapter.register(EMBASSY_NAME, EMBASSY_DESCRIPTION);
        if (!creds) {
          console.log("\n❌ Registration failed.\n");
          break;
        }
        console.log(`\n✓ Registered.\n`);
        console.log(`  1. Go to: ${creds.claim_url}`);
        console.log(`  2. Post the code: ${creds.verification_code}`);
        console.log(`  3. Run register again\n`);
        break;
      }

      console.log(
        (await adapter.claimed())
          ? "\n✓ The Embassy is claimed and active.\n"
          : "\n⏳ Registered, claim still pending.\n"
      );
      break;
    }

    default:
      usage();
  }
}

function usage(specific?: string): void {
  if (specific) {
    console.log(`\nUsage: embassy ${specific}\n`);
    return;
  }
  console.log(`
🌉 THE EMBASSY v2 — a scoped translation relay

  charter             validate and print the charter
  scan <edge>         read one inbound edge
  bulletin            agent-space → human bulletin
  ask "<question>"    human question → agent-space
  ledger [n]          recent crossings
  verify <id>         source and rendering, side by side
  register            claim the Embassy on Moltbook

Channels live in CHARTER.md. Edit that file, not the prompts.
`);
}

main().catch((err) => {
  if (err instanceof ScopeViolation) {
    console.error(`\n⛔ scope: ${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof RateExceeded) {
    console.error(`\n⏳ rate: ${err.message}\n`);
    process.exit(3);
  }
  if (err instanceof CharterError || err instanceof UnknownTransform) {
    console.error(`\n📜 charter: ${err.message}\n`);
    process.exit(4);
  }
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
