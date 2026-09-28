#!/usr/bin/env node
/**
 * THE EMBASSY v2 — scoped translation relay
 *
 * Exit codes: 0 ok · 1 error · 2 scope violation · 3 rate exceeded · 4 charter invalid · 5 usage
 */

import "dotenv/config";
import { Charter, ScopeViolation, CharterError } from "./charter";
import { Ledger } from "./ledger";
import { Embassy, RateExceeded, LedgerLocked } from "./relay";
import { UnknownTransform, loadSoul } from "./transforms";
import { Adapter, ForgedEdge, NotConfigured } from "./adapters/types";
import { buildAdapters, lintCharter } from "./adapters/index";
import { HomeNotFound } from "./home";

class Usage extends Error {}

function flags(args: string[]): { args: string[]; dryRun: boolean; json: boolean } {
  return {
    args: args.filter((a) => !a.startsWith("--")),
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
  };
}

async function open(dryRun = false): Promise<{ embassy: Embassy; adapters: Adapter[] }> {
  const charter = Charter.load();
  const problems = lintCharter(charter);
  if (problems.length) throw new CharterError(`charter has ${problems.length} problem(s) — run: embassy charter`);
  const adapters = buildAdapters(charter);
  const embassy = new Embassy(charter, adapters, { dryRun });
  if (await embassy.noteCharter()) console.log(`📜 charter ${charter.hash.slice(0, 12)} recorded to ledger (${charter.sourcePath})`);
  return { embassy, adapters };
}

function table(rows: string[][], header: string[]): void {
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  console.log("   " + header.map((h, i) => h.toUpperCase().padEnd(w[i])).join("  "));
  console.log("   " + "─".repeat(w.reduce((a, n) => a + n + 2, 0)));
  for (const r of rows) console.log("   " + r.map((c, i) => (c ?? "").padEnd(w[i])).join("  "));
}

function printCharter(charter: Charter): void {
  const { meta } = charter;
  console.log(`\n🌉 ${meta.embassy} v${meta.version}`);
  console.log(`   scope: ${meta.scope}   default: ${meta.default}   provenance: ${meta.provenance}`);
  console.log(`   model: ${meta.model}   endpoint: ${meta.endpoint ?? "api.anthropic.com"}`);
  console.log(`   source: ${charter.sourcePath}   sha256: ${charter.hash.slice(0, 16)}\n`);

  console.log("   Platforms");
  table(charter.platforms().map((p) => [p.id, p.adapter, p.base ?? "—"]), ["platform", "adapter", "base"]);
  console.log("\n   Channels");
  table(charter.list().map((e) => [e.id, e.platform, e.channel, e.role, e.direction, e.transform, e.rate ? `${e.rate.count}/${e.rate.per}` : "—"]), ["id", "platform", "channel", "role", "dir", "transform", "rate"]);
  const routes = charter.routes();
  if (routes.length) {
    console.log("\n   Routes");
    table(routes.map((r) => [r.id, r.from.join("+"), r.to, r.title || "—"]), ["route", "from", "to", "title"]);
  }
  console.log(`\n   ${charter.list().length} channels on ${charter.platforms().length} platforms, ${routes.length} routes. Everything else is outside the wall.`);

  const problems = lintCharter(charter);
  if (problems.length) {
    console.log(`\n   ⚠ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`     - ${p}`);
    console.log();
    process.exitCode = 4;
  } else {
    console.log("   ✓ every channel parses for its adapter\n");
  }
}

async function main(): Promise<void> {
  const { args, dryRun, json } = flags(process.argv.slice(2));
  const [command, ...rest] = args;

  switch (command) {
    case "charter": {
      printCharter(Charter.load());
      break;
    }

    case "doctor": {
      const charter = Charter.load();
      const problems = lintCharter(charter);
      const chain = new Ledger().verifyChain();
      let soul = "✓ loaded";
      try { loadSoul(); } catch (e) { soul = "✗ " + (e as Error).message; }
      console.log(`\n🩺 Embassy doctor\n`);
      console.log(`   charter      ${problems.length ? "✗ " + problems.length + " problem(s) — run: embassy charter" : "✓ valid"}`);
      console.log(`   soul         ${soul}`);
      console.log(`   api key      ${process.env.ANTHROPIC_API_KEY ? "✓ set" : "✗ ANTHROPIC_API_KEY not set"}`);
      console.log(`   ledger       ${chain.ok ? `✓ chain intact, ${chain.entries} entries, head #${chain.head.seq}` : `✗ ${chain.reason}`}`);
      console.log(`   rollback     ${chain.signed ? "✓ sidecar signed (keep EMBASSY_LEDGER_KEY off this host)" : "⚠ unsigned — set EMBASSY_LEDGER_KEY, and verify against delivered anchors"}`);
      console.log();
      let bad = problems.length > 0 || !chain.ok;
      for (const adapter of buildAdapters(charter, { quiet: true })) {
        const r = await adapter.check();
        console.log(`   ${adapter.platform.padEnd(12)} ${r.ok ? "✓" : "✗"} ${adapter.kind} — ${r.detail}`);
        if (!r.ok) bad = true;
      }
      console.log();
      if (bad) process.exitCode = 1;
      break;
    }

    case "platforms": {
      const charter = Charter.load();
      console.log();
      table(charter.platforms().map((p) => [p.id, p.adapter, p.base ?? "—"]), ["platform", "adapter", "base"]);
      console.log();
      break;
    }

    case "register": {
      const platformId = rest[0];
      if (!platformId) throw new Usage("register <platform>   (a platform alias from CHARTER.md)");
      const charter = Charter.load();
      charter.platform(platformId); // throws CharterError if unknown
      const adapter = buildAdapters(charter, { quiet: true }).find((a) => a.platform === platformId)!;
      if (!adapter.setup) { console.log(`\n${platformId}: nothing to set up for ${adapter.kind}\n`); break; }
      console.log("\n" + (await adapter.setup()) + "\n");
      break;
    }

    case "run": {
      const routeId = rest[0];
      if (!routeId) throw new Usage('run <route> ["text"]');
      const text = rest.slice(1).join(" ") || undefined;
      const { embassy } = await open(dryRun);
      const result = await embassy.run(routeId, text);
      if (!result) { console.log("\nNothing new since the last delivered crossing.\n"); break; }
      const route = embassy.charter.route(routeId);
      if (result.dryRun) {
        console.log(`\n── DRY RUN · route ${routeId} · would be crossing ${result.crossing.id} → ${route.to} ──\n`);
        console.log(result.crossing.body + "\n");
        break;
      }
      console.log(`\n✓ ${routeId}: crossing ${result.crossing.id} → ${result.delivery?.ref}\n`);
      break;
    }

    // Sugar for the two routes every charter is expected to have.
    case "bulletin":
    case "ask": {
      const { embassy } = await open(dryRun);
      const text = command === "ask" ? rest.join(" ") : undefined;
      if (command === "ask" && !text) throw new Usage('ask "your question"');
      const result = await embassy.run(command, text);
      if (!result) { console.log("\nNothing new since the last delivered crossing.\n"); break; }
      const route = embassy.charter.route(command);
      if (result.dryRun) {
        console.log(`\n── DRY RUN · would be crossing ${result.crossing.id} → ${route.to} ──\n`);
        console.log(result.crossing.body + "\n");
        break;
      }
      console.log(`\n✓ crossing ${result.crossing.id} → ${result.delivery?.ref}\n`);
      break;
    }

    case "scan": {
      const edgeId = rest[0];
      if (!edgeId) throw new Usage("scan <edge-id>");
      const { embassy } = await open();
      const messages = await embassy.collect(edgeId);
      if (json) { console.log(JSON.stringify(messages, null, 2)); break; }
      console.log(`\n${messages.length} on '${edgeId}'\n`);
      for (const m of messages) console.log(`  ${String(m.signal ?? 0).padStart(4)}↑  ${(m.title || m.body.slice(0, 70).replace(/\n/g, " ")) || "(empty)"}  — ${m.author}`);
      console.log();
      break;
    }

    case "redeliver": {
      const id = rest[0];
      if (!id) throw new Usage("redeliver <crossing-id>");
      const { embassy } = await open();
      const delivery = await embassy.redeliver(id);
      console.log(`\n✓ redelivered ${id} → ${delivery.ref}\n`);
      break;
    }

    case "ledger": {
      const sub = rest[0];
      const ledger = new Ledger();
      if (sub === "head") { const h = ledger.head(); console.log(`\n  #${h.seq}  ${h.hash}\n`); break; }
      if (sub === "verify") {
        const anchor = rest[1]?.match(/^#?(\d+)[:\s]+([0-9a-f]{8,64})$/i);
        const r = ledger.verifyChain(anchor ? { expect: { seq: parseInt(anchor[1], 10), hash: anchor[2].toLowerCase() } } : {});
        const assurance: Record<typeof r.assurance, string> = {
          anchored: "✓ matches a delivered anchor — rollback ruled out for everything up to it",
          signed: "✓ sidecar signed with EMBASSY_LEDGER_KEY — rollback ruled out if the key is held off-host",
          "sidecar-unsigned": "⚠ intact against edits; rollback NOT ruled out (unsigned sidecar) — set EMBASSY_LEDGER_KEY or verify against a delivered anchor: embassy ledger verify N:hash",
          none: "⚠ nothing to compare against",
        };
        console.log(`\n  ${r.ok ? "✓ chain intact" : "✗ chain broken"}  ·  ${r.entries} entries  ·  head #${r.head.seq} ${r.head.hash.slice(0, 16)}`);
        console.log(`  ${assurance[r.assurance]}`);
        if (!r.ok) console.log(`  ${r.reason}${r.corruptLines.length ? ` · unparseable lines: ${r.corruptLines.join(", ")}` : ""}`);
        console.log();
        if (!r.ok) process.exitCode = 1;
        break;
      }
      const n = Math.max(1, parseInt(sub || "20", 10) || 20);
      const crossings = ledger.recent(n);
      if (json) { console.log(JSON.stringify(crossings, null, 2)); break; }
      if (!crossings.length) { console.log("\nNo crossings recorded yet.\n"); break; }
      console.log();
      for (const c of crossings) {
        const d = ledger.deliveryOf(c.id);
        console.log(`  ${c.id}  ${c.at.slice(0, 19).replace("T", " ")}  ${c.from.join("+")} → ${c.to}  via ${c.transform}  ${d ? "✓" : "✗ undelivered"}`);
      }
      console.log(`\n  ${crossings.length} shown · embassy verify <id> · embassy ledger verify · embassy ledger head\n`);
      break;
    }

    case "verify": {
      const id = rest[0];
      if (!id) throw new Usage("verify <crossing-id>");
      const ledger = new Ledger();
      const { ok, crossing, reason } = ledger.verify(id);
      if (!crossing) { console.log(`\nNo crossing '${id}'.\n`); process.exitCode = 1; break; }
      const d = ledger.deliveryOf(id);
      console.log(`\n  crossing ${crossing.id}   ${ok ? "✓ intact" : `✗ ${reason}`}   seq #${crossing.seq}`);
      console.log(`  ${crossing.at}   ${crossing.from.join("+")} → ${crossing.to} via ${crossing.transform}   model ${crossing.model} · prompt v${crossing.promptVersion} · soul ${crossing.soulHash.slice(0, 12)}${crossing.strippedLines ? ` · ${crossing.strippedLines} line(s) filtered from model output` : ""}`);
      console.log(`  anchor ledger #${crossing.anchor.seq} ${crossing.anchor.hash.slice(0, 12)}   delivered: ${d ? d.ref : "no"}`);
      if (crossing.sources.length) console.log(`  sources: ${crossing.sources.join(", ")}`);
      console.log("\n  ── AS RECEIVED " + "─".repeat(48));
      console.log(crossing.source.split("\n").map((l) => "  " + l).join("\n"));
      console.log("\n  ── AS DELIVERED (exact body) " + "─".repeat(35));
      console.log(crossing.body.split("\n").map((l) => "  " + l).join("\n"));
      console.log();
      if (!ok) process.exitCode = 1;
      break;
    }

    case undefined:
    case "help":
      usage();
      break;

    default:
      throw new Usage(`unknown command '${command}'`);
  }
}

function usage(): void {
  console.log(`
🌉 THE EMBASSY v2 — a scoped translation relay

  charter                  validate and print platforms, channels, routes
  doctor                   charter, soul, key, ledger chain, every platform's health
  platforms                list platform aliases and their adapters
  register <platform>      one-time setup for a platform (register / paste a token)
  run <route> ["text"]     run a charter route             [--dry-run]
  bulletin | ask "text"    sugar for: run bulletin | run ask "text"
  scan <edge>              read one inbound edge            [--json]
  redeliver <id>           resend a recorded but undelivered crossing
  ledger [n|head|verify]   the record                        [--json]
  verify <id>              one crossing: as received vs. as delivered

Where the Embassy may reach lives in CHARTER.md. Edit that file, not the prompts.
Exit codes: 0 ok · 1 error · 2 scope · 3 rate · 4 charter · 5 usage
`);
}

main().catch((err) => {
  const msg = (err as Error).message;
  if (err instanceof Usage) { console.error(`\nUsage: embassy ${msg}\n`); process.exit(5); }
  if (err instanceof ScopeViolation || err instanceof ForgedEdge) { console.error(`\n⛔ scope: ${msg}\n`); process.exit(2); }
  if (err instanceof RateExceeded) { console.error(`\n⏳ rate: ${msg}\n`); process.exit(3); }
  if (err instanceof CharterError || err instanceof UnknownTransform || err instanceof HomeNotFound) { console.error(`\n📜 charter: ${msg}\n`); process.exit(4); }
  if (err instanceof LedgerLocked) { console.error(`\n🔒 ${msg}\n`); process.exit(1); }
  if (err instanceof NotConfigured) { console.error(`\n🔑 ${msg}\n`); process.exit(1); }
  const crossing = (err as any).crossing;
  console.error(`\n✗ ${msg}${crossing ? `\n  crossing ${crossing.id} is recorded but undelivered — embassy redeliver ${crossing.id}` : ""}\n`);
  process.exit(1);
});
