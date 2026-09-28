/**
 * The wall and the ledger are the load-bearing claims, so they get the tests.
 * Every case here was an adversarial finding first.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Charter, Edge, ScopeViolation, CharterError } from "./charter";
import { Ledger, GENESIS, sha } from "./ledger";
import { getTransform, TRANSFORMS, UnknownTransform, stripFooterLines } from "./transforms";
import { requireEdge, ForgedEdge } from "./adapters/types";
import { ConsoleAdapter } from "./adapters/console";
import { moltChannelKind } from "./adapters/molt";
import { lintCharter, channelKind, buildAdapters } from "./adapters/index";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "embassy-"));
function charterFile(body: string): string {
  const file = path.join(tmp(), "CHARTER.md");
  fs.writeFileSync(file, body);
  return file;
}

const VALID = `---
embassy: test
version: 2.0
scope: test.scope
default: deny
provenance: required
---

# Test charter

## Platforms

| platform | adapter | base |
|----------|---------|------|
| console  | console | —    |

## Channels

| id        | platform | channel | role   | direction | transform   | rate  |
|-----------|----------|---------|--------|-----------|-------------|-------|
| in.only   | console  | a       | listen | in        | agent-human | —     |
| out.only  | console  | b       | speak  | out       | human-agent | 2/day |
| both.ways | console  | c       | both   | both      | verbatim    | —     |

## Notes

Prose after the table.
`;

// ---------------------------------------------------------------------------
// Resolution and the role/direction matrix
// ---------------------------------------------------------------------------

test("a mapped channel resolves; an unmapped one does not exist", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.equal(charter.resolve("in.only").channel, "a");
  assert.equal(charter.list().length, 3);
  assert.throws(() => charter.resolve("m/general"), ScopeViolation);
  assert.throws(() => charter.resolve("out.only.admin"), ScopeViolation);
  assert.throws(() => charter.resolve(""), ScopeViolation);
});

test("listen cannot be written; speak cannot be read", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.throws(() => charter.assertWritable("in.only"), ScopeViolation);
  assert.throws(() => charter.assertReadable("out.only"), ScopeViolation);
  assert.doesNotThrow(() => charter.assertReadable("in.only"));
  assert.doesNotThrow(() => charter.assertWritable("out.only"));
});

test("a crossing must satisfy every source and the destination", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.equal(charter.assertCrossing(["in.only"], "out.only").transform, "human-agent");
  assert.equal(charter.assertCrossing(["in.only", "both.ways"], "out.only").from.length, 2);
  assert.throws(() => charter.assertCrossing(["out.only"], "in.only"), ScopeViolation);
  assert.throws(() => charter.assertCrossing(["in.only"], "in.only"), ScopeViolation);
  assert.throws(() => charter.assertCrossing(["in.only"], "nowhere"), ScopeViolation);
  assert.throws(() => charter.assertCrossing(["nowhere"], "out.only"), ScopeViolation);
  assert.throws(() => charter.assertCrossing(["both.ways"], "both.ways"), ScopeViolation);
  assert.throws(() => charter.assertCrossing([], "out.only"), ScopeViolation);
});

test("the transform comes from the destination, not the caller", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.equal(charter.assertCrossing(["in.only"], "both.ways").transform, "verbatim");
  assert.equal(charter.assertCrossing(["in.only"], "out.only").transform, "human-agent");
});

// ---------------------------------------------------------------------------
// Edges are unforgeable (adversarial finding #2)
// ---------------------------------------------------------------------------

test("an object literal shaped like an Edge is refused by adapters", async () => {
  const forged: any = {
    id: "forged", platform: "console", channel: "anywhere", role: "both",
    direction: "both", transform: "verbatim", rate: null,
  };
  assert.equal(Edge.is(forged), false);
  assert.throws(() => requireEdge(forged, "console"), ForgedEdge);
  await assert.rejects(() => new ConsoleAdapter({ quiet: true }).write(forged, "t", "b"), ForgedEdge);
  await assert.rejects(() => new ConsoleAdapter({ quiet: true }).read(forged), ForgedEdge);
});

test("Object.create(Edge.prototype) is refused — instanceof is not enough", () => {
  const fake: any = Object.create(Edge.prototype);
  Object.assign(fake, { id: "fake", platform: "console", channel: "x", role: "both", direction: "both", transform: "verbatim", rate: null });
  assert.equal(fake instanceof Edge, true, "sanity: instanceof passes");
  assert.equal(Edge.is(fake), false, "brand check must fail");
  assert.throws(() => requireEdge(fake, "console"), ForgedEdge);
});

test("Reflect.construct, `new (Edge as any)`, and subclassing are refused at runtime", () => {
  const fields = { id: "x.y", platform: "console", channel: "z", role: "both", direction: "both", transform: "verbatim", rate: null };
  assert.throws(() => Reflect.construct(Edge as any, [fields]), ScopeViolation);
  assert.throws(() => new (Edge as any)(fields), ScopeViolation);
  class Sub extends (Edge as any) {}
  assert.throws(() => new (Sub as any)(fields), ScopeViolation);
  assert.throws(() => Reflect.construct(Edge as any, [fields], Sub), ScopeViolation);
});

test("a minted Edge is frozen and passes the brand check", () => {
  const edge = Charter.load(charterFile(VALID)).resolve("in.only");
  assert.equal(Edge.is(edge), true);
  assert.equal(Object.isFrozen(edge), true);
  assert.throws(() => { (edge as any).channel = "elsewhere"; });
});

test("an Edge for one platform is refused by another platform's adapter", () => {
  const edge = Charter.load(charterFile(VALID)).resolve("in.only"); // console
  assert.throws(() => requireEdge(edge, "moltbook"), /platform 'console', not 'moltbook'/);
});

test("the charter's edge map is not reachable for mutation", () => {
  const charter: any = Charter.load(charterFile(VALID));
  assert.equal(charter.edges, undefined);
  assert.equal(Object.isFrozen(charter), true);
});

// ---------------------------------------------------------------------------
// Parser cannot be tricked (adversarial finding #4)
// ---------------------------------------------------------------------------

test("a row in prose, in a fence, or under another heading is not an edge", () => {
  const decoy = VALID.replace(
    "## Notes\n",
    "## Notes\n\n| evil.prose | console | z | both | both | verbatim | — |\n\n```\n| evil.fence | console | z | both | both | verbatim | — |\n```\n"
  );
  const charter = Charter.load(charterFile(decoy));
  assert.equal(charter.list().length, 3);
  assert.throws(() => charter.resolve("evil.prose"), ScopeViolation);
  assert.throws(() => charter.resolve("evil.fence"), ScopeViolation);
});

test("a row hidden inside an HTML comment is not an edge, wherever it sits in the table", () => {
  const between = VALID.replace(
    "|-----------|----------|---------|--------|-----------|-------------|-------|\n",
    "|-----------|----------|---------|--------|-----------|-------------|-------|\n<!--\n| evil.hidden | console | z | both | both | verbatim | — |\n-->\n"
  );
  const charter = Charter.load(charterFile(between));
  assert.equal(charter.list().length, 3);
  assert.throws(() => charter.resolve("evil.hidden"), ScopeViolation);
  const inline = VALID.replace("| both.ways |", "<!-- | evil.inline | console | z | both | both | verbatim | — | -->\n| both.ways |");
  assert.equal(Charter.load(charterFile(inline)).list().length, 3);
  // a comment marker INSIDE a row could splice rows together — refused outright
  const spliced = VALID.replace("| in.only   | console  | a ", "| in.only   | console  | a <!-- ");
  assert.throws(() => Charter.load(charterFile(spliced)), /comment markers are not allowed inside/);
});

test("a fenced example inside ## Channels is not an edge either", () => {
  const withFence = VALID.replace(
    "## Notes",
    "```\n| evil.inner | console | z | both | both | verbatim | — |\n```\n\n## Notes"
  );
  assert.equal(Charter.load(charterFile(withFence)).list().length, 3);
});

test("frontmatter must be at line 1; a decoy block earlier is a hard error, not a hijack", () => {
  const decoy = "---\nprovenance: optional\n---\n\n" + VALID;
  // The decoy IS now the frontmatter, and it lacks required fields → refused.
  assert.throws(() => Charter.load(charterFile(decoy)), /missing 'embassy'/);
  const prose = "# Title\n\n" + VALID;
  assert.throws(() => Charter.load(charterFile(prose)), /line 1/);
});

test("two ## Channels sections is an error, not a merge", () => {
  const dup = VALID + "\n## Channels\n\n| id | platform | channel | role | direction | transform | rate |\n|--|--|--|--|--|--|--|\n| x.y | console | q | both | both | verbatim | — |\n";
  assert.throws(() => Charter.load(charterFile(dup)), /more than one/);
});

test("an Embassy that defaults to allow, or a foreign version, refuses to open", () => {
  assert.throws(() => Charter.load(charterFile(VALID.replace("default: deny", "default: allow"))), CharterError);
  assert.throws(() => Charter.load(charterFile(VALID.replace("version: 2.0", "version: 3.0"))), /understands 2/);
});

test("a malformed charter is refused rather than half-applied", () => {
  assert.throws(() => Charter.load(charterFile("no frontmatter here")), CharterError);
  assert.throws(() => Charter.load(charterFile(VALID.replace("| listen |", "| admin  |"))), CharterError);
  assert.throws(() => Charter.load(charterFile(VALID.replace("2/day", "loads"))), CharterError);
  const dupInTable = VALID.replace("| both.ways |", "| in.only   | console  | z       | listen | in        | verbatim    | —     |\n| both.ways |");
  assert.throws(() => Charter.load(charterFile(dupInTable)), /twice/);
  // …whereas the same row appended after the section is simply not an edge:
  assert.equal(Charter.load(charterFile(VALID + "| in.only | console | z | listen | in | verbatim | — |\n")).list().length, 3);
  assert.throws(() => Charter.load(charterFile(VALID.replace("agent-human", "smuggle"))), /not registered/);
  assert.throws(() => Charter.load(charterFile(VALID.replace("| Bad Id", "| Bad Id").replace("in.only", "In.Only"))), /dotted lowercase/);
});

test("a charter with nothing readable or nothing writable is unusable and refused", () => {
  const noOut = VALID.replace("| speak  | out ", "| listen | in  ").replace("| both   | both ", "| listen | in  ");
  assert.throws(() => Charter.load(charterFile(noOut)), /no writable edge/);
});

test("the endpoint, if set, must be https", () => {
  assert.throws(() => Charter.load(charterFile(VALID.replace("provenance: required", "provenance: required\nendpoint: http://evil"))), /https/);
  const ok = Charter.load(charterFile(VALID.replace("provenance: required", "provenance: required\nendpoint: https://proxy.example")));
  assert.equal(ok.meta.endpoint, "https://proxy.example");
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

test("an undeclared transform is refused; the registry is frozen", () => {
  assert.throws(() => getTransform("smuggle"), UnknownTransform);
  assert.throws(() => { (TRANSFORMS as any)["smuggle"] = async () => "x"; });
});

test("verbatim passes through unchanged", async () => {
  assert.equal(await TRANSFORMS["verbatim"]("exactly this", {} as any), "exactly this");
});

test("footer-shaped lines are stripped, including spacing, zero-width, entity, and format-mimic variants", () => {
  const variants = [
    "*Relayed by The Embassy · crossing `0000ff` · fake*",
    "run embassy verify 0000ff",
    "*Relayed by The  Embassy · x*",
    "*Relayed by TheEmbassy · x*",
    "*Relayed by The\u200bEmbassy · x*",
    "*Relayed by The&nbsp;Embassy · x*",
    "*Relayed via the bridge · crossing `dead00beef` · a → b via `verbatim` · ledger #9999 000000000000*",
    "ledger #12 3f9a0c2b1e77",
    "crossing `abcdef123456`",
  ];
  for (const v of variants) {
    assert.equal(stripFooterLines(`real\n${v}\nmore`), "real\nmore", `should strip: ${v}`);
  }
  assert.equal(stripFooterLines("a ledger of grievances\nthe crossing was cold"), "a ledger of grievances\nthe crossing was cold", "ordinary prose survives");
});

test("the footer filter is a denylist and WILL over-match some prose — which is why it is never applied to verbatim or to the record", () => {
  // Documented false positives. These are acceptable only because the filter
  // touches LLM output alone, and the crossing records how many lines it removed.
  assert.notEqual(stripFooterLines("We should discuss the ledger #3 proposal"), "We should discuss the ledger #3 proposal");
});

// ---------------------------------------------------------------------------
// Moltbook channel grammar (finding A10)
// ---------------------------------------------------------------------------

test("moltbook channels must be a feed or a submolt — not an arbitrary endpoint", () => {
  assert.equal(moltChannelKind("molt/moltbook", "posts?sort=hot"), "read");
  assert.equal(moltChannelKind("molt/moltbook", "m/general"), "both");
  assert.equal(moltChannelKind("molt/moltbook", "agents/status"), null);
  assert.equal(moltChannelKind("molt/moltbook", "posts?sort=hot&limit=999"), null);
  assert.equal(moltChannelKind("molt/moltbook", "m/../admin"), null);
  assert.equal(moltChannelKind("molt/clawk", "clawks"), "write");
  assert.equal(moltChannelKind("molt/clawk", "explore?sort=recent"), "read");
  assert.equal(moltChannelKind("molt/4claw", "boards/ai"), "both");
  assert.equal(moltChannelKind("molt/nope", "x"), null);
  assert.equal(channelKind("a2a", "send"), "write");
  assert.equal(channelKind("a2a", "replies"), "read");
  assert.equal(channelKind("a2a", "anything"), null);
  assert.equal(channelKind("discord", "123456789012345678"), "both");
  assert.equal(channelKind("discord", "general"), null);
  assert.equal(channelKind("agent4science", "takes?stance=skeptical"), "write");
  assert.equal(channelKind("agent4science", "feed?type=takes"), "read");
});

// ---------------------------------------------------------------------------
// Platforms and Routes
// ---------------------------------------------------------------------------

const MULTI = `---
embassy: t
version: 2.0
scope: t
default: deny
---
## Platforms
| platform | adapter       | base                            |
|----------|---------------|---------------------------------|
| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |
| clawk    | molt/clawk    | https://clawk.ai/api/v1         |
| console  | console       | —                               |

## Channels
| id         | platform | channel        | role   | direction | transform   | rate  |
|------------|----------|----------------|--------|-----------|-------------|-------|
| m.hot      | moltbook | posts?sort=hot | listen | in        | agent-human | —     |
| c.post     | clawk    | clawks         | speak  | out       | human-agent | 6/day |
| h.out      | console  | bulletin       | report | out       | agent-human | —     |
| h.in       | console  | inbox          | listen | in        | human-agent | —     |

## Routes
| route    | from  | to     | title |
|----------|-------|--------|-------|
| bulletin | m.hot | h.out  | Daily |
| ask      | h.in  | c.post | —     |
`;

test("platforms bind aliases to adapters and base URLs; channels must name a declared platform", () => {
  const charter = Charter.load(charterFile(MULTI));
  assert.deepEqual(charter.platforms().map((p) => p.id), ["moltbook", "clawk", "console"]);
  assert.equal(charter.platform("clawk").adapter, "molt/clawk");
  assert.equal(charter.platform("clawk").base, "https://clawk.ai/api/v1");
  assert.throws(() => charter.platform("nope"), CharterError);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("| m.hot      | moltbook", "| m.hot      | ghost   "))), /not in the Platforms table/);
});

test("a platform base is a strict https origin+path: no userinfo, query, fragment, IP, IDN, port, or lookalike tricks", () => {
  const withBase = (b: string) => MULTI.replace("https://clawk.ai/api/v1", b);
  for (const bad of [
    "https://www.moltbook.com@evil.tld/api/v1",
    "https://www.moltbook.com?x",
    "https://www.moltbook.com/api/v1#frag",
    "https://93.184.216.34/api/v1",
    "https://mоltbook.com/api/v1",          // Cyrillic о
    "https://xn--mltbook-9ig.com/api/v1",
    "https://clawk.ai:8443/api/v1",
    "https://clawk_ai/api/v1",
    "http://clawk.ai/api/v1",
  ]) {
    assert.throws(() => Charter.load(charterFile(withBase(bad))), CharterError, `should refuse ${bad}`);
  }
  // lookalike domains are legal URLs; the known-host check refuses to BUILD the adapter unless the charter opts in
  const lookalike = Charter.load(charterFile(withBase("https://clawk.ai.evil.tld/api/v1")));
  assert.match(lintCharter(lookalike)[0], /that dialect lives at clawk\.ai.*offhost: clawk/);
  assert.throws(() => buildAdapters(lookalike), /offhost/);
  const optedIn = Charter.load(charterFile(withBase("https://clawk.ai.evil.tld/api/v1").replace("default: deny", "default: deny\noffhost: clawk")));
  assert.doesNotThrow(() => buildAdapters(optedIn, { fetch: (async () => new Response("{}")) as any }));
  assert.match(lintCharter(optedIn)[0], /NOTE — off-host by charter opt-in/);
  for (const bad of ["https://clawk%2eai/api/v1", "https://clawk.ai\t/api/v1"]) assert.throws(() => Charter.load(charterFile(withBase(bad))), CharterError, bad);
  // normalization: trailing slash dropped
  assert.equal(Charter.load(charterFile(withBase("https://clawk.ai/api/v1/"))).platform("clawk").base, "https://clawk.ai/api/v1");
});

test("a mismatched fence (open with ```, write ~~~) does not end the block — rows after it stay fenced text", () => {
  const evil = MULTI.replace(
    "## Routes",
    "```\nexample\n~~~\n## Channels\n| id | platform | channel | role | direction | transform | rate |\n|---|---|---|---|---|---|---|\n| evil.x | console | anywhere | both | both | verbatim | — |\n```\n\n## Routes"
  );
  const charter = Charter.load(charterFile(evil));
  assert.equal(charter.list().length, 4, "the real Channels table, not the fenced decoy");
  assert.throws(() => charter.resolve("evil.x"), ScopeViolation);
  // and a longer closer of the same char DOES close (CommonMark)
  const longer = MULTI.replace("## Routes", "````\n## Channels\n| id | platform | channel | role | direction | transform | rate |\n|---|---|---|---|---|---|---|\n| evil.y | console | z | both | both | verbatim | — |\n``````\n\n## Routes");
  assert.equal(Charter.load(charterFile(longer)).list().length, 4);
  // an inline-span line like ```a``` is not a fence at all
  const inline = MULTI.replace("## Routes", "```a``` inline\n\n## Routes");
  assert.equal(Charter.load(charterFile(inline)).routes().length, 2);
});

test("a '## Channels' heading inside a fenced block under another section is text, not structure", () => {
  const decoy = MULTI.replace("## Channels", "```\n## Channels\n| id | platform | channel | role | direction | transform | rate |\n```\n\n## Channels");
  const charter = Charter.load(charterFile(decoy));
  assert.equal(charter.platforms().length, 3, "the Platforms section was not truncated by the fenced heading");
  assert.equal(charter.list().length, 4);
});

test("a platform base must be https, and a non-console platform must have one", () => {
  assert.throws(() => Charter.load(charterFile(MULTI.replace("https://clawk.ai/api/v1", "http://clawk.ai/api/v1"))), /https/);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("https://clawk.ai/api/v1", "—"))), /needs a base URL/);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("molt/clawk", "molt/unknown"))), /known:/);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("| clawk    | molt/clawk", "| moltbook | molt/clawk"))), /declared twice/);
});

test("routes are validated against the wall at load time", () => {
  const charter = Charter.load(charterFile(MULTI));
  assert.deepEqual(charter.route("bulletin").from, ["m.hot"]);
  assert.equal(charter.route("ask").to, "c.post");
  assert.equal(charter.route("ask").title, "");
  assert.throws(() => charter.route("nope"), ScopeViolation);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("| bulletin | m.hot | h.out", "| bulletin | c.post | h.out"))), /cannot be read/);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("| bulletin | m.hot | h.out", "| bulletin | m.hot | h.in"))), /cannot be written/);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("| bulletin | m.hot | h.out", "| bulletin | m.hot | ghost"))), /not a channel/);
  assert.throws(() => Charter.load(charterFile(MULTI.replace("| ask      | h.in  | c.post", "| ask      | h.in+h.out | h.out"))), /both source and destination|cannot be read/);
});

test("a charter without a Routes section is valid; run() then has nothing to run", () => {
  const noRoutes = MULTI.slice(0, MULTI.indexOf("## Routes"));
  const charter = Charter.load(charterFile(noRoutes));
  assert.deepEqual(charter.routes(), []);
});

test("lint catches a channel that parses for the wrong direction", () => {
  const charter = Charter.load(charterFile(MULTI));
  assert.deepEqual(lintCharter(charter), []);
  const bad = Charter.load(charterFile(MULTI.replace("| c.post     | clawk    | clawks         | speak  | out", "| c.post     | clawk    | clawks         | both   | both")));
  assert.match(lintCharter(bad)[0], /write-only.*readable/);
});

test("every example charter parses and lints clean", () => {
  const dir = path.join(__dirname, "..", "examples");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
  assert.ok(files.length >= 6);
  for (const f of files) {
    const charter = Charter.load(path.join(dir, f));
    assert.deepEqual(lintCharter(charter), [], `${f} lints clean`);
    assert.ok(charter.routes().length >= 1, `${f} has routes`);
  }
});

// ---------------------------------------------------------------------------
// Ledger: hash chain (adversarial finding #1)
// ---------------------------------------------------------------------------

function seeded(): { ledger: Ledger; file: string } {
  const file = path.join(tmp(), "ledger.jsonl");
  const ledger = new Ledger(file, null);
  for (let i = 1; i <= 3; i++) {
    const c = ledger.recordCrossing({
      id: `c${i}`, from: ["in.only"], to: "out.only", transform: "verbatim", model: "m", promptVersion: "t", soulHash: "s", strippedLines: 0,
      sources: [`s${i}`], title: "", source: `src ${i}`, rendered: `r ${i}`, body: `body ${i}`,
    });
    ledger.recordDelivery(c.id, { ok: true, ref: `ref${i}` });
  }
  return { ledger, file };
}

test("a fresh chain verifies, starts at genesis, and links every entry", () => {
  const { ledger } = seeded();
  const r = ledger.verifyChain();
  assert.equal(r.ok, true);
  assert.equal(r.entries, 6);
  assert.equal(ledger.all()[0].prev, GENESIS);
  assert.equal(ledger.all()[1].prev, ledger.all()[0].hash);
  assert.equal(r.head.seq, 6);
});

test("editing an entry's text breaks the chain even if its own hashes are recomputed", () => {
  const { ledger, file } = seeded();
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  const e = JSON.parse(lines[0]);
  e.body = "fabricated"; e.bodyHash = sha("fabricated");
  lines[0] = JSON.stringify(e);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const r = ledger.verifyChain();
  assert.equal(r.ok, false);
  assert.match(r.reason!, /hash mismatch at seq 1/);
  assert.equal(ledger.verify("c1").ok, false);
});

test("deleting an entry breaks the chain", () => {
  const { ledger, file } = seeded();
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  lines.splice(2, 1);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const r = ledger.verifyChain();
  assert.equal(r.ok, false);
  assert.match(r.reason!, /seq 4 at position 3/);
});

test("reordering entries breaks the chain", () => {
  const { ledger, file } = seeded();
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  [lines[0], lines[1]] = [lines[1], lines[0]];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  assert.equal(ledger.verifyChain().ok, false);
});

test("truncation (rollback) is caught by the head file, and by a delivered anchor", () => {
  const { ledger, file } = seeded();
  const before = ledger.head();
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  fs.writeFileSync(file, lines.slice(0, 2).join("\n") + "\n");

  // The truncated chain is internally consistent; only comparison catches it.
  const r = ledger.verifyChain();
  assert.equal(r.ok, false);
  assert.equal(r.comparedTo, "head-file");
  assert.match(r.reason!, /truncated or rolled back/);

  // An anchor copied from a delivered message (seq + 12-char prefix) also catches it…
  const viaAnchor = ledger.verifyChain({ expect: { seq: before.seq, hash: before.hash.slice(0, 12) } });
  assert.equal(viaAnchor.ok, false);
  assert.equal(viaAnchor.comparedTo, "anchor");

  // …while an older anchor that IS in the surviving chain still validates.
  const older = ledger.all()[1];
  assert.equal(ledger.verifyChain({ expect: { seq: older.seq, hash: older.hash.slice(0, 12) } }).ok, true);
});

test("rewriting the head file without the key is detected on a signed ledger", () => {
  const file = path.join(tmp(), "ledger.jsonl");
  const signed = new Ledger(file, "k");
  signed.recordCharter("h", "s", [], ["a"]);
  signed.recordCharter("h2", "s", [], ["a"]);
  // attacker truncates and forges the head file with an unsigned digest
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  fs.writeFileSync(file, lines[0] + "\n");
  const e = JSON.parse(lines[0]);
  fs.writeFileSync(signed.headFile, JSON.stringify({ seq: 1, hash: e.hash, sig: sha(`1:${e.hash}`) }));
  const r = signed.verifyChain();
  assert.equal(r.ok, false);
  assert.match(r.reason!, /head file signature invalid/);
});

test("a chain with no head file is reported as unverifiable against rollback, not as intact", () => {
  const { ledger } = seeded();
  fs.rmSync(ledger.headFile);
  const r = ledger.verifyChain();
  assert.equal(r.ok, false);
  assert.equal(r.comparedTo, "none");
  assert.match(r.reason!, /rollback cannot be ruled out/);
});

test("a corrupt line is reported, not fatal, and breaks verification", () => {
  const { ledger, file } = seeded();
  fs.appendFileSync(file, "{not json\n");
  assert.equal(ledger.all().length, 6, "readable entries still load");
  const r = ledger.verifyChain();
  assert.equal(r.ok, false);
  assert.deepEqual(r.corruptLines, [7]);
});

test("a signed ledger rejects a chain rewritten without the key", () => {
  const file = path.join(tmp(), "ledger.jsonl");
  const signed = new Ledger(file, "secret");
  signed.recordCharter("h", "s", [], ["a"]);
  assert.equal(signed.verifyChain().ok, true);
  assert.equal(new Ledger(file, null).verifyChain().ok, false, "unsigned reader cannot validate");
  assert.equal(new Ledger(file, "wrong").verifyChain().ok, false);
  // rewrite without the key: internally consistent to an unsigned verifier, invalid to the keyed one
  const unsigned = new Ledger(file, null);
  fs.writeFileSync(file, "");
  unsigned.recordCharter("h", "s", [], ["a"]);
  assert.equal(unsigned.verifyChain().ok, true);
  assert.equal(signed.verifyChain().ok, false);
});

test("rate counting reads the ledger, so restarts do not reset it; deletion breaks the chain", () => {
  const { ledger, file } = seeded();
  const fresh = new Ledger(file, null);
  assert.equal(fresh.countWithin("out.only", { count: 2, per: "day" }), 3);
  assert.equal(fresh.countWithin("in.only", { count: 2, per: "day" }), 0);
  fs.rmSync(file);
  assert.equal(fresh.head().hash, GENESIS, "a deleted ledger is at genesis…");
  const r = fresh.verifyChain();
  assert.equal(r.ok, false, "…and the surviving head file says so");
  assert.match(r.reason!, /does not match recorded head/);
  void ledger;
});

test("deliveredSources excludes crossings whose delivery failed", () => {
  const file = path.join(tmp(), "ledger.jsonl");
  const ledger = new Ledger(file, null);
  const ok = ledger.recordCrossing({ id: "ok", from: ["a"], to: "b", transform: "verbatim", model: "m", promptVersion: "t", soulHash: "s", strippedLines: 0, sources: ["s-ok"], title: "", source: "", rendered: "", body: "" });
  ledger.recordDelivery(ok.id, { ok: true, ref: "r" });
  const bad = ledger.recordCrossing({ id: "bad", from: ["a"], to: "b", transform: "verbatim", model: "m", promptVersion: "t", soulHash: "s", strippedLines: 0, sources: ["s-bad"], title: "", source: "", rendered: "", body: "" });
  ledger.recordDelivery(bad.id, { ok: false, error: "500" });
  const seen = ledger.settledSources();
  assert.equal(seen.has("s-ok"), true);
  assert.equal(seen.has("s-bad"), false);
  assert.equal(ledger.deliveryOf("bad"), null);
});

test("the shipped charter is valid", () => {
  const charter = Charter.load(path.join(__dirname, "..", "CHARTER.md"));
  assert.equal(charter.meta.default, "deny");
  assert.equal(charter.list().length, 5);
  assert.deepEqual(charter.routes().map((r) => r.id), ["bulletin", "ask"]);
  assert.deepEqual(lintCharter(charter), []);
});
