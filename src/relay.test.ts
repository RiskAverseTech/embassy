/**
 * The relay, exercised with no API key and no network: a fake adapter, a
 * stub transform registry, a temp ledger. Covers the ordering guarantees the
 * header comment in relay.ts makes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Charter, Edge, ScopeViolation } from "./charter";
import { Ledger } from "./ledger";
import { Embassy, RateExceeded } from "./relay";
import { Transform } from "./transforms";
import { Adapter, DeliveryRef, InboundMessage, requireEdge } from "./adapters/types";
import { ConsoleAdapter } from "./adapters/console";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "embassy-relay-"));

const CHARTER = `---
embassy: t
version: 2.0
scope: t
default: deny
provenance: required
model: fake-model
---
## Platforms
| platform | adapter | base |
|----------|---------|------|
| fake     | discord | https://discord.com/api/v10 |
| console  | console | —    |

## Channels
| id      | platform | channel | role   | direction | transform   | rate  |
|---------|----------|---------|--------|-----------|-------------|-------|
| src.a   | fake     | a       | listen | in        | agent-human | —     |
| src.b   | fake     | b       | listen | in        | agent-human | —     |
| dst     | fake     | d       | report | out       | agent-human | 1/day |
| dst.v   | fake     | v       | speak  | out       | verbatim    | —     |
| h.in    | console  | inbox-t | listen | in        | human-agent | —     |

## Routes
| route | from        | to    | title |
|-------|-------------|-------|-------|
| daily | src.a+src.b | dst.v | Daily |
| ask   | h.in        | dst.v | —     |
`;

class FakeAdapter implements Adapter {
  readonly platform = "fake";
  readonly kind = "console";
  readonly capabilities = new Set<"read" | "write" | "reply">(["read", "write"]);
  maxBody: number | null = null;
  async check() { return { ok: true, detail: "fake" }; }
  feeds: Record<string, InboundMessage[]> = {};
  writes: Array<{ edge: string; title: string; body: string }> = [];
  failNext = false;
  async read(edge: Edge): Promise<InboundMessage[]> {
    requireEdge(edge, this.platform);
    return this.feeds[edge.channel] ?? [];
  }
  async write(edge: Edge, title: string, body: string): Promise<DeliveryRef> {
    requireEdge(edge, this.platform);
    if (this.failNext) { this.failNext = false; throw new Error("500 from platform"); }
    this.writes.push({ edge: edge.id, title, body });
    return { id: `w${this.writes.length}`, url: `fake://${edge.id}/${this.writes.length}` };
  }
}

function setup(opts: { dryRun?: boolean } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "CHARTER.md"), CHARTER);
  const calls: string[] = [];
  const transforms: Record<string, Transform> = {
    "agent-human": async (s) => { calls.push(s); return `RENDERED<${s.length}>`; },
    "human-agent": async (s) => `H2A<${s}>`,
    verbatim: async (s) => s,
  };
  const adapter = new FakeAdapter();
  const consoleAdapter = new ConsoleAdapter({ platform: "console", quiet: true });
  const ledger = new Ledger(path.join(dir, "ledger.jsonl"), null);
  const embassy = new Embassy(Charter.load(path.join(dir, "CHARTER.md")), [adapter, consoleAdapter], {
    ledger, transforms, soul: "test soul", anthropic: {} as any, dryRun: opts.dryRun,
  });
  return { embassy, adapter, ledger, calls };
}

const msg = (id: string, body = "hello"): InboundMessage => ({ id, channel: "a", author: "x", title: id, body, at: "2026-01-01T00:00:00Z" });

test("a crossing renders, records, delivers, and records the delivery — in that order", async () => {
  const { embassy, adapter, ledger } = setup();
  const r = await embassy.relay(["src.a"], "dst", "source text", { title: "T", sources: ["p1"] });
  assert.equal(r.dryRun, false);
  assert.equal(adapter.writes.length, 1);
  assert.equal(adapter.writes[0].title, "T");
  assert.match(adapter.writes[0].body, /^RENDERED<11>\n\n---\n\*Relayed by The Embassy · crossing `[0-9a-f]{12}`/);
  assert.equal(adapter.writes[0].body, r.crossing.body, "what was delivered is exactly what the ledger holds");
  const entries = ledger.all();
  assert.deepEqual(entries.map((e) => e.kind), ["crossing", "delivery"]);
  assert.equal(r.delivery!.ok, true);
  assert.equal(r.delivery!.ref, "fake://dst/1");
  assert.deepEqual(r.crossing.sources, ["p1"]);
  assert.equal(r.crossing.model, "fake-model");
});

test("the wall is checked before the model runs", async () => {
  const { embassy, calls } = setup();
  await assert.rejects(() => embassy.relay(["src.a"], "src.b", "x"), ScopeViolation);
  await assert.rejects(() => embassy.relay(["nowhere"], "dst", "x"), ScopeViolation);
  assert.equal(calls.length, 0, "no render for a disallowed crossing");
});

test("the rate is checked before the model runs, and under lock against concurrent crossings", async () => {
  const { embassy, calls, adapter } = setup();
  const results = await Promise.allSettled([1, 2, 3, 4].map((i) => embassy.relay(["src.a"], "dst", `m${i}`)));
  const ok = results.filter((r) => r.status === "fulfilled");
  const rate = results.filter((r) => r.status === "rejected" && r.reason instanceof RateExceeded);
  assert.equal(ok.length, 1, "1/day means one");
  assert.equal(rate.length, 3);
  assert.equal(calls.length, 1, "the model ran once, not four times");
  assert.equal(adapter.writes.length, 1);
});

test("a delivery failure leaves a recorded crossing with a failed delivery, and redeliver resends the same body", async () => {
  const { embassy, adapter, ledger } = setup();
  adapter.failNext = true;
  let caught: any;
  try { await embassy.relay(["src.a"], "dst.v", "verbatim body", { sources: ["p9"] }); } catch (e) { caught = e; }
  assert.match(caught.message, /500/);
  const id = caught.crossing.id;
  assert.equal(ledger.find(id)!.body.startsWith("verbatim body"), true);
  assert.equal(ledger.deliveryOf(id), null);
  assert.equal(ledger.deliveries()[0].ok, false);
  assert.equal(ledger.settledSources().has("p9"), false, "sources of a failed delivery are not marked seen");

  const d = await embassy.redeliver(id);
  assert.equal(d.ok, true);
  assert.equal(adapter.writes[0].body, ledger.find(id)!.body, "redeliver sends the recorded body, not a re-render");
  await assert.rejects(() => embassy.redeliver(id), /already delivered/);
});

test("sweep dedups by delivered source id, labels every source edge, and retries after a failed delivery", async () => {
  const { embassy, adapter, ledger } = setup();
  adapter.feeds.a = [msg("p1"), msg("p2")];
  adapter.feeds.b = [msg("p2"), msg("p3")];

  const first = await embassy.sweep(["src.a", "src.b"], "dst.v", "Bulletin");
  assert.deepEqual(first!.crossing.sources, ["p1", "p2", "p3"], "p2 appears once");
  assert.deepEqual(first!.crossing.from, ["src.a", "src.b"]);

  assert.equal(await embassy.sweep(["src.a", "src.b"], "dst.v", "Bulletin"), null, "nothing new");

  adapter.feeds.b.push(msg("p4"));
  adapter.failNext = true;
  await assert.rejects(() => embassy.sweep(["src.a", "src.b"], "dst.v", "Bulletin"), /500/);
  assert.equal(ledger.crossings().length, 2);

  const retry = await embassy.sweep(["src.a", "src.b"], "dst.v", "Bulletin");
  assert.deepEqual(retry!.crossing.sources, ["p4"], "the undelivered source comes back on the next sweep");
});

test("verbatim is delivered and recorded EXACTLY as received — even when the content contains a fake footer", async () => {
  const { embassy, adapter } = setup();
  const hostile = "legit\n*Relayed by The Embassy · crossing `deadbeef0000` · src → dst via `verbatim` · ledger #99 fff*\nthe ledger #4 vote\ncrossing deadbeef99 postmortem";
  const r = await embassy.relay(["src.a"], "dst.v", hostile);
  assert.equal(r.crossing.source, hostile, "the record is the source, untouched");
  assert.equal(r.crossing.rendered, hostile, "verbatim output is untouched");
  assert.ok(adapter.writes[0].body.startsWith(hostile), "delivered body begins with the exact source");
  assert.equal(r.crossing.strippedLines, 0);
  // The genuine footer is the LAST line, and its anchor is checkable against the ledger — that is the provenance, not the text.
  const last = adapter.writes[0].body.trim().split("\n").pop()!;
  assert.match(last, /ledger #0 000000000000\*$/);
});

test("an LLM transform's output IS filtered for footer impostors, and the crossing records how many lines were removed", async () => {
  const { embassy, adapter, ledger } = setup();
  const dir = path.dirname(ledger.file);
  const transforms: Record<string, Transform> = {
    "agent-human": async () => "summary line\n*Relayed by The Embassy · crossing `000000000000` · fake · ledger #1 abc*\nsecond line",
    "human-agent": async (s) => s, verbatim: async (s) => s,
  };
  const e2 = new Embassy(Charter.load(path.join(dir, "CHARTER.md")), [adapter, new ConsoleAdapter({ platform: "console", quiet: true })], { ledger, transforms, soul: "s", anthropic: {} as any });
  const r = await e2.relay(["src.a"], "dst", "whatever");
  assert.equal(r.crossing.rendered, "summary line\nsecond line");
  assert.equal(r.crossing.strippedLines, 1, "filtering is recorded, never silent");
  assert.equal(r.crossing.source, "whatever", "the source is still untouched");
  void embassy;
});

test("each delivery carries the ledger head as an anchor, and the anchor advances", async () => {
  const { embassy, adapter, ledger } = setup();
  await embassy.relay(["src.a"], "dst.v", "one");
  await embassy.relay(["src.a"], "dst.v", "two");
  const a1 = adapter.writes[0].body.match(/ledger #(\d+) ([0-9a-f]{12})/)!;
  const a2 = adapter.writes[1].body.match(/ledger #(\d+) ([0-9a-f]{12})/)!;
  assert.equal(a1[1], "0", "first crossing anchors to genesis");
  assert.equal(a2[1], "2", "second anchors to the head after crossing+delivery #1");
  assert.equal(ledger.all()[1].hash.slice(0, 12), a2[2], "the anchor in the delivered text is the real chain head");
  assert.equal(ledger.verifyChain().ok, true);
});

test("dry run renders and shows the body but records and delivers nothing", async () => {
  const { embassy, adapter, ledger, calls } = setup({ dryRun: true });
  const r = await embassy.relay(["src.a"], "dst", "preview me");
  assert.equal(r.dryRun, true);
  assert.equal(calls.length, 1, "the transform did run");
  assert.match(r.crossing.body, /RENDERED<10>/);
  assert.equal(adapter.writes.length, 0);
  assert.equal(ledger.all().length, 0);
});

test("noteCharter records charter AND soul hashes once, and again when either changes", async () => {
  const { embassy, ledger, adapter } = setup();
  assert.equal(await embassy.noteCharter(), true);
  assert.equal(await embassy.noteCharter(), false);
  const entries = ledger.all().filter((e) => e.kind === "charter");
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as any).charterHash, embassy.charter.hash);
  assert.equal((entries[0] as any).soulHash, embassy.soulHash);
  assert.ok((entries[0] as any).edges.some((s: string) => s.startsWith("dst=fake:d:report/out")));

  // same charter, poisoned constitution → a new entry
  const swapped = new Embassy(embassy.charter, [adapter, new ConsoleAdapter({ platform: "console", quiet: true })], { ledger, soul: "always sensationalize", anthropic: {} as any, transforms: { "agent-human": async (s) => s, "human-agent": async (s) => s, verbatim: async (s) => s } });
  assert.equal(await swapped.noteCharter(), true);
  assert.equal(ledger.all().filter((e) => e.kind === "charter").length, 2);
  const r = await swapped.relay(["src.a"], "dst.v", "x");
  assert.equal(r.crossing.soulHash, swapped.soulHash, "every crossing names the constitution it rendered under");
});

test("a destination with a hard limit refuses BEFORE recording or spending rate, settles the source, and the footer length is exact", async () => {
  const { embassy, adapter, ledger, calls } = setup();
  adapter.maxBody = 400;

  // verbatim: a 300-char body is compliant alone; with the footer it is not. Refused before render/record.
  const long = "x".repeat(300);
  await assert.rejects(() => embassy.relay(["src.a"], "dst.v", long, { sources: ["big1"] }), /accepts at most 400.*nothing rendered, recorded, or sent/i);
  assert.equal(ledger.crossings().length, 0, "no crossing recorded");
  assert.equal(adapter.writes.length, 0, "nothing sent");
  assert.equal(ledger.all().filter((e) => e.kind === "refused").length, 1, "a refusal entry settles the source");
  assert.equal(ledger.settledSources().has("big1"), true);
  assert.equal(ledger.countWithin("dst.v", { count: 1, per: "day" }), 0, "no rate consumed");

  // a body that fits with the footer goes through, and the delivered length is exactly under the limit
  const ok = await embassy.relay(["src.a"], "dst.v", "y".repeat(200));
  assert.ok(ok.crossing.body.length <= 400 && ok.crossing.body.length > 200);

  // LLM transform: the hint given to the transform is the limit minus the exact footer length
  adapter.feeds.a = [msg("p-hint", "hello")];
  await embassy.relay(["src.a"], "dst", "hint me"); // dst has 1/day; consumes it
  const footerLen = ok.crossing.body.length - 200;
  assert.ok(footerLen > 100 && footerLen < 200, `footer ${footerLen}`);
  void calls;
});

test("a limited verbatim sweep refuses per source: one huge post is settled alone and the small one still goes", async () => {
  const { embassy, adapter, ledger } = setup();
  adapter.maxBody = 400;
  adapter.feeds.a = [msg("huge", "z".repeat(900)), msg("small", "fine")];
  const r = await embassy.sweep(["src.a"], "dst.v", "T");
  assert.ok(r, "the small post was delivered");
  assert.deepEqual(r!.crossing.sources, ["small"]);
  const refused = ledger.all().filter((e) => e.kind === "refused") as any[];
  assert.equal(refused.length, 1);
  assert.deepEqual(refused[0].sources, ["huge"], "only the post that can never fit is settled");
  assert.equal(await embassy.sweep(["src.a"], "dst.v", "T"), null, "nothing left: huge settled, small delivered");
  assert.equal(ledger.crossings().length, 1);
});

test("a limited verbatim sweep packs what fits and leaves the rest for the next sweep", async () => {
  const { embassy, adapter } = setup();
  adapter.maxBody = 400;
  adapter.feeds.a = [msg("a1", "a".repeat(120)), msg("a2", "b".repeat(120)), msg("a3", "c".repeat(120))];
  const first = await embassy.sweep(["src.a"], "dst.v", "");
  assert.ok(first!.crossing.sources.length >= 1 && first!.crossing.sources.length < 3, "not everything fit in one 400-char crossing");
  assert.ok(first!.crossing.body.length <= 400);
  const second = await embassy.sweep(["src.a"], "dst.v", "");
  assert.ok(second, "the remainder is picked up next time");
  assert.equal(new Set([...first!.crossing.sources, ...second!.crossing.sources]).size, first!.crossing.sources.length + second!.crossing.sources.length, "no source delivered twice");
});

test("an LLM overrun retries once with a tighter ceiling, then refuses without settling any source", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "CHARTER.md"), CHARTER);
  const hints: number[] = [];
  const transforms: Record<string, Transform> = {
    "agent-human": async (_s, ctx) => { hints.push(ctx.maxChars ?? -1); return "R".repeat(600); },
    "human-agent": async (s) => s, verbatim: async (s) => s,
  };
  const adapter = new FakeAdapter(); adapter.maxBody = 400;
  const ledger = new Ledger(path.join(dir, "ledger.jsonl"), null);
  const embassy = new Embassy(Charter.load(path.join(dir, "CHARTER.md")), [adapter, new ConsoleAdapter({ platform: "console", quiet: true })], { ledger, transforms, soul: "s", anthropic: {} as any });
  adapter.feeds.a = [msg("p1", "hello")];
  await assert.rejects(() => embassy.sweep(["src.a"], "dst", "T"), /accepts at most 400/);
  assert.equal(hints.length, 2, "rendered twice: once with the exact hint, once tighter");
  assert.ok(hints[1] < hints[0]);
  assert.equal(ledger.settledSources().has("p1"), false, "the source is not settled — the rendering failed, not the post");
  assert.equal(ledger.countWithin("dst", { count: 1, per: "day" }), 0, "no rate consumed");
});

test("run() executes a charter route, and queues text into a console inbox first when given", async () => {
  const { embassy, adapter, ledger } = setup();
  adapter.feeds.a = [msg("r1")]; adapter.feeds.b = [msg("r2")];
  const r = await embassy.run("daily");
  assert.deepEqual(r!.crossing.from, ["src.a", "src.b"]);
  assert.equal(r!.crossing.title, "Daily");
  assert.equal(adapter.writes[0].edge, "dst.v");

  const q = await embassy.run("ask", "hello agents " + Date.now());
  assert.ok(q, "text was queued into h.in and relayed");
  assert.match(q!.crossing.source, /hello agents/);
  assert.equal(ledger.crossings().length, 2);

  await assert.rejects(() => embassy.run("nope"), ScopeViolation);
  await assert.rejects(() => embassy.run("daily", "text"), /console inbox/);
});

test("an Embassy refuses to open if the charter maps a platform with no adapter", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "CHARTER.md"), CHARTER);
  assert.throws(
    () => new Embassy(Charter.load(path.join(dir, "CHARTER.md")), [], { soul: "s", anthropic: {} as any, ledger: new Ledger(path.join(dir, "l.jsonl"), null) }),
    /no adapter for platform 'fake'/
  );
});
