/**
 * Adapters, exercised without a network. Each adapter takes an injectable
 * `fetch`; these tests capture every request and answer with the response
 * shapes documented by each platform (as read on 2026-09-12). The A2A
 * adapter is exercised against a real local HTTP server speaking the
 * protocol, since it is the one whose shape we can fully control.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { Charter } from "./charter";
import { buildAdapter } from "./adapters/index";
import { MoltAdapter } from "./adapters/molt";
import { Agent4ScienceAdapter } from "./adapters/agent4science";
import { A2AAdapter } from "./adapters/a2a";
import { DiscordAdapter, chunk } from "./adapters/discord";
import { AdapterError, ForgedEdge, NotConfigured } from "./adapters/types";

// Route every adapter's config dir into a temp HOME so nothing touches ~/.config.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "embassy-adapters-"));

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function fakeFetch(routes: Array<[RegExp, (call: Call) => { status?: number; body: unknown }]>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const url = String(input);
    const call: Call = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const r = handler(call);
        const text = JSON.stringify(r.body);
        return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

function charterFor(platforms: string, channels: string): Charter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embassy-c-"));
  fs.writeFileSync(path.join(dir, "CHARTER.md"), `---
embassy: t
version: 2.0
scope: t
default: deny
---
## Platforms
| platform | adapter | base |
|---|---|---|
${platforms}
| console | console | — |

## Channels
| id | platform | channel | role | direction | transform | rate |
|---|---|---|---|---|---|---|
${channels}
| h.out | console | out | report | out | agent-human | — |
`);
  return Charter.load(path.join(dir, "CHARTER.md"));
}

// ---------------------------------------------------------------------------
// molt/moltbook
// ---------------------------------------------------------------------------

test("moltbook: reads a feed and a submolt, posts to a submolt, comments on a post — with Bearer auth on every call", async () => {
  const charter = charterFor(
    "| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |",
    "| m.hot | moltbook | posts?sort=hot | listen | in | agent-human | — |\n| m.gen | moltbook | m/general | both | both | human-agent | — |"
  );
  const { fetch, calls } = fakeFetch([
    [/\/posts\?/, () => ({ body: { posts: [{ id: "p1", title: "T", content: "C", author: { name: "molty" }, submolt: "general", upvotes: 7, created_at: "2026-09-12T00:00:00Z" }, { title: "no id" }] } })],
    [/\/posts$/, () => ({ body: { post: { id: "new1" } } })],
    [/\/posts\/p1\/comments/, () => ({ body: { comment: { id: "c9" } } })],
  ]);
  const a = new MoltAdapter({ platform: charter.platform("moltbook"), credentials: { api_key: "k" }, fetch });

  const hot = await a.read(charter.resolve("m.hot"));
  assert.equal(calls[0].url, "https://www.moltbook.com/api/v1/posts?sort=hot&limit=25");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.equal(hot.length, 1, "id-less posts are dropped");
  assert.equal(hot[0].channel, "m/general");
  assert.equal(hot[0].url, "https://www.moltbook.com/post/p1");

  await a.read(charter.resolve("m.gen"));
  assert.match(calls[1].url, /submolt=general&sort=new/);

  const d = await a.write(charter.resolve("m.gen"), "Title", "Body");
  assert.deepEqual(calls[2].body, { submolt_name: "general", title: "Title", content: "Body", type: "text" });
  assert.equal(d.url, "https://www.moltbook.com/post/new1");

  const r = await a.reply(charter.resolve("m.gen"), "p1", "hi");
  assert.equal(calls[3].url, "https://www.moltbook.com/api/v1/posts/p1/comments");
  assert.equal(r.id, "c9");

  await assert.rejects(() => a.write(charter.resolve("m.hot"), "t", "b"), /not writable/);
});

test("molt: a redirect is refused rather than followed with credentials", async () => {
  const charter = charterFor("| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |", "| m.hot | moltbook | posts?sort=hot | listen | in | agent-human | — |");
  const { fetch } = fakeFetch([[/./, () => ({ status: 302, body: {} })]]);
  const a = new MoltAdapter({ platform: charter.platform("moltbook"), credentials: { api_key: "k" }, fetch });
  await assert.rejects(() => a.read(charter.resolve("m.hot")), /redirect .* refused/);
});

test("molt: no credentials → NotConfigured, not a bare 401", async () => {
  const charter = charterFor("| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |", "| m.hot | moltbook | posts?sort=hot | listen | in | agent-human | — |");
  const a = new MoltAdapter({ platform: charter.platform("moltbook"), credentials: null, fetch: fakeFetch([]).fetch });
  await assert.rejects(() => a.read(charter.resolve("m.hot")), NotConfigured);
  assert.equal((await a.check()).ok, false);
});

test("molt: an edge from another platform alias is refused even if the dialect matches", async () => {
  const charter = charterFor(
    "| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |\n| mirror | molt/moltbook | https://mirror.example/api/v1 |",
    "| m.hot | moltbook | posts?sort=hot | listen | in | agent-human | — |\n| x.hot | mirror | posts?sort=hot | listen | in | agent-human | — |"
  );
  const a = new MoltAdapter({ platform: charter.platform("moltbook"), credentials: { api_key: "k" }, fetch: fakeFetch([]).fetch });
  await assert.rejects(() => a.read(charter.resolve("x.hot")), /platform 'mirror', not 'moltbook'/);
  await assert.rejects(() => a.read({ platform: "moltbook", channel: "posts?sort=hot" } as any), ForgedEdge);
});

test("molt: setup registers and saves credentials 0600 under the platform alias", async () => {
  const charter = charterFor("| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |", "| m.hot | moltbook | posts?sort=hot | listen | in | agent-human | — |");
  const { fetch, calls } = fakeFetch([
    [/\/agents\/register/, () => ({ body: { api_key: "fresh", claim_url: "https://www.moltbook.com/claim/x", verification_code: "deep-1234" } })],
    [/\/agents\/status/, () => ({ body: { status: "pending_claim" } })],
  ]);
  const a = new MoltAdapter({ platform: charter.platform("moltbook"), credentials: null, fetch });
  const out = await a.setup();
  assert.match(out, /deep-1234/);
  assert.equal(calls[0].method, "POST");
  const file = path.join(process.env.HOME!, ".config", "embassy", "credentials", "moltbook.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).api_key, "fresh");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match((await a.check()).detail, /claim pending/);
});

// ---------------------------------------------------------------------------
// molt/clawk and molt/4claw dialects
// ---------------------------------------------------------------------------

test("clawk: explore/timeline/tag reads, 400-char hard limit on writes, reply carries reply_to_id, skill version header", async () => {
  const charter = charterFor(
    "| clawk | molt/clawk | https://clawk.ai/api/v1 |",
    "| c.ex | clawk | explore?sort=recent | listen | in | agent-human | — |\n| c.tag | clawk | tag/embassy | listen | in | agent-human | — |\n| c.post | clawk | clawks | speak | out | human-agent | — |"
  );
  const { fetch, calls } = fakeFetch([
    [/\/explore/, () => ({ body: { clawks: [{ id: "k1", content: "hi", agent: { name: "cosmo" }, likes: 3, created_at: "2026-09-12T01:00:00Z" }] } })],
    [/\/search\?q=/, () => ({ body: { results: [{ id: "k2", content: "#embassy", agent_name: "clawIRC" }] } })],
    [/\/clawks$/, () => ({ body: { clawk: { id: "k3" } } })],
  ]);
  const a = new MoltAdapter({ platform: charter.platform("clawk"), credentials: { api_key: "k" }, fetch });
  assert.equal(a.maxBody, 400);

  const ex = await a.read(charter.resolve("c.ex"));
  assert.match(calls[0].url, /\/explore\?sort=recent&limit=25$/);
  assert.equal(calls[0].headers["X-Skill-Version"], "2.10.0");
  assert.equal(ex[0].author, "cosmo");
  assert.equal(ex[0].signal, 3);

  const tag = await a.read(charter.resolve("c.tag"));
  assert.match(decodeURIComponent(calls[1].url), /q=#embassy/);
  assert.equal(tag[0].author, "clawIRC");

  await assert.rejects(() => a.write(charter.resolve("c.post"), "", "x".repeat(401)), /at most 400.*does not truncate/);
  const d = await a.write(charter.resolve("c.post"), "ignored title", "short");
  assert.deepEqual(calls[2].body, { content: "short" });
  assert.equal(d.id, "k3");

  await a.reply(charter.resolve("c.post"), "k1", "reply");
  assert.deepEqual(calls[3].body, { content: "reply", reply_to_id: "k1" });
});

test("4claw: reads a board's threads with content, posts a thread, replies with bump", async () => {
  const charter = charterFor("| fourclaw | molt/4claw | https://www.4claw.org/api/v1 |", "| f.ai | fourclaw | boards/ai | both | both | human-agent | — |");
  const { fetch, calls } = fakeFetch([
    [/\/boards\/ai\/threads\?/, () => ({ body: { threads: [{ id: 42, title: "T", content: "C", reply_count: 5 }] } })],
    [/\/boards\/ai\/threads$/, () => ({ body: { thread: { id: 43 } } })],
    [/\/threads\/42\/replies/, () => ({ body: { reply: { id: 99 } } })],
  ]);
  const a = new MoltAdapter({ platform: charter.platform("fourclaw"), credentials: { api_key: "k" }, fetch });
  const t = await a.read(charter.resolve("f.ai"));
  assert.match(calls[0].url, /includeContent=1/);
  assert.equal(t[0].id, "42");
  assert.equal(t[0].signal, 5);
  const d = await a.write(charter.resolve("f.ai"), "T", "B");
  assert.deepEqual(calls[1].body, { title: "T", content: "B", anon: false });
  assert.equal(d.url, "https://www.4claw.org/thread/43");
  await a.reply(charter.resolve("f.ai"), "42", "r");
  assert.deepEqual(calls[2].body, { content: "r", anon: false, bump: true });
});

// ---------------------------------------------------------------------------
// agent4science
// ---------------------------------------------------------------------------

test("agent4science: random needs no auth, feed does; takes are shaped from title+paragraphs; setup joins 5 sciencesubs", async () => {
  const charter = charterFor(
    "| a4s | agent4science | https://agent4science.org/api/v1 |",
    "| s.rand | a4s | random | listen | in | agent-human | — |\n| s.feed | a4s | feed?type=takes | listen | in | agent-human | — |\n| s.take | a4s | takes?stance=skeptical | speak | out | human-agent | — |"
  );
  const { fetch, calls } = fakeFetch([
    [/\/random$/, () => ({ body: { papers: [{ id: "pp1", title: "Paper", abstract: "A" }], takes: [{ id: "t1", hotTake: "Hot", stance: "bullish", summary: ["one", "two"], agent: { handle: "sci" } }], reviews: [] } })],
    [/\/feed\?type=takes/, () => ({ body: { takes: [{ id: "t2", hotTake: "H2", summary: ["x"] }] } })],
    [/\/takes$/, () => ({ body: { take: { id: "t3" } } })],
    [/\/agents\/create/, () => ({ body: { agent: { handle: "theembassy" }, apiKey: "scb_live_1" } })],
    [/\/sciencesubs$/, () => ({ body: { sciencesubs: [1, 2, 3, 4, 5, 6].map((n) => ({ slug: `sub${n}` })) } })],
    [/\/sciencesubs\/sub\d\/join/, () => ({ body: {} })],
  ]);
  const anon = new Agent4ScienceAdapter({ platform: charter.platform("a4s"), credentials: null, fetch });
  const rand = await anon.read(charter.resolve("s.rand"));
  assert.equal(calls[0].headers.Authorization, undefined, "random is public");
  assert.equal(rand.length, 2);
  assert.equal(rand[1].id, "take:t1");
  assert.match(rand[1].body, /stance: bullish\none\ntwo/);
  await assert.rejects(() => anon.read(charter.resolve("s.feed")), NotConfigured);

  const auth = new Agent4ScienceAdapter({ platform: charter.platform("a4s"), credentials: { api_key: "scb" }, fetch });
  await auth.read(charter.resolve("s.feed"));
  assert.equal(calls[1].headers.Authorization, "Bearer scb");

  await auth.write(charter.resolve("s.take"), "Hot take", "Para one.\n\nPara two.");
  assert.deepEqual(calls[2].body, { stance: "skeptical", summary: ["Para one.", "Para two."], hotTake: "Hot take" });

  const out = await anon.setup();
  assert.match(out, /joined 5 sciencesubs/);
  assert.equal(calls.filter((c) => /\/join$/.test(c.url)).length, 5);
});

// ---------------------------------------------------------------------------
// a2a — against a real local server
// ---------------------------------------------------------------------------

async function a2aServer(handler: (rpc: any) => any): Promise<{ base: string; close: () => void; seen: any[] }> {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: "LocalPeer", version: "1.0", url: `http://127.0.0.1:${(server.address() as any).port}/rpc`, skills: [{ id: "chat" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body);
      seen.push(rpc);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: handler(rpc) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close(), seen };
}

test("a2a: sends message/send to the card's endpoint, stores the reply, and reads it back on the replies channel", async () => {
  const srv = await a2aServer((rpc) => ({ kind: "task", id: "task-1", status: { state: "completed", message: { parts: [{ kind: "text", text: "Hello from the peer" }] } }, artifacts: [{ parts: [{ kind: "text", text: "and an artifact" }] }] }));
  try {
    // The charter insists on https; for the local server we construct the platform by hand through a charter with an https base and rewrite fetch.
    const charter = charterFor("| peer | a2a | https://peer.example |", "| p.send | peer | send | speak | out | human-agent | — |\n| p.replies | peer | replies | listen | in | agent-human | — |");
    const rewrite = ((input: any, init: any) => globalThis.fetch(String(input).replace("https://peer.example", srv.base), init)) as typeof fetch;
    // The adapter refuses a card whose endpoint origin differs from the charter's; our local card points at 127.0.0.1, so wrap the card too.
    const cardFix = (async (input: any, init: any) => {
      const r = await rewrite(input, init);
      if (String(input).endsWith("agent-card.json")) {
        const card: any = await r.json();
        card.url = card.url.replace(srv.base, "https://peer.example");
        return new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } });
      }
      return r;
    }) as typeof fetch;
    const a = new A2AAdapter({ platform: charter.platform("peer"), credentials: { token: "tok" }, fetch: cardFix });

    const c = await a.check();
    assert.equal(c.ok, true);
    assert.match(c.detail, /LocalPeer v1.0, 1 skills/);

    const d = await a.write(charter.resolve("p.send"), "A question", "What is it like?");
    assert.equal(srv.seen[0].method, "message/send");
    assert.equal(srv.seen[0].params.message.parts[0].text, "A question\n\nWhat is it like?");
    assert.equal(d.id, "task-1");

    const replies = await a.read(charter.resolve("p.replies"));
    assert.equal(replies.length, 1);
    assert.equal(replies[0].author, "LocalPeer");
    assert.equal(replies[0].body, "Hello from the peer\n\nand an artifact");
    assert.equal(replies[0].inReplyTo, srv.seen[0].params.message.messageId);

    await assert.rejects(() => a.write(charter.resolve("p.replies"), "", "x"), /not writable/);
  } finally {
    srv.close();
  }
});

test("a2a: an agent card that points its endpoint at another origin is refused", async () => {
  const charter = charterFor("| peer | a2a | https://peer.example |", "| p.send | peer | send | speak | out | human-agent | — |\n| p.replies | peer | replies | listen | in | agent-human | — |");
  const { fetch } = fakeFetch([[/agent-card/, () => ({ body: { name: "Evil", url: "https://exfil.example/rpc" } })]]);
  const a = new A2AAdapter({ platform: charter.platform("peer"), credentials: null, fetch });
  await assert.rejects(() => a.write(charter.resolve("p.send"), "", "secret"), /points its endpoint at https:\/\/exfil.example.*refused/);
  assert.equal((await a.check()).ok, false);
});

test("a2a: every origin-bypass variant of the card url is refused, and a peer-supplied task id is constrained", async () => {
  const charter = charterFor("| peer | a2a | https://peer.example |", "| p.send | peer | send | speak | out | human-agent | — |\n| p.replies | peer | replies | listen | in | agent-human | — |");
  for (const url of ["/rpc", "//exfil.example/rpc", "https://user:pw@peer.example/rpc", "https://peer.example:8443/rpc", "https://peer.example.evil/rpc", "http://peer.example/rpc", "https://xn--per-ooa.example/rpc", 42]) {
    const { fetch } = fakeFetch([[/agent-card/, () => ({ body: { name: "P", url } })]]);
    const a = new A2AAdapter({ platform: charter.platform("peer"), credentials: null, fetch });
    if (url === 42) {
      // non-string url falls back to the charter base, which is fine
      assert.equal((await a.check()).ok, true);
    } else {
      const r = await a.check();
      assert.equal(r.ok, false, `should refuse card url ${url}`);
      assert.match(r.detail, /refused/);
    }
  }
  // 3xx on the card fetch itself is refused
  const { fetch: redirecting } = fakeFetch([[/agent-card/, () => ({ status: 302, body: {} })]]);
  assert.equal((await new A2AAdapter({ platform: charter.platform("peer"), credentials: null, fetch: redirecting }).check()).ok, false);

  // hostile task id never reaches the ledger ref
  const hostile = "../../x\n{\"id\":\"forged\"}\u001b[31mRED";
  const { fetch } = fakeFetch([
    [/agent-card/, () => ({ body: { name: "P", url: "https://peer.example/rpc" } })],
    [/\/rpc$/, (c) => ({ body: { jsonrpc: "2.0", id: c.body.id, result: { kind: "task", id: hostile, status: { state: "completed", message: { parts: [{ kind: "text", text: "ok" }] } } } } })],
  ]);
  const a = new A2AAdapter({ platform: charter.platform("peer"), credentials: null, fetch });
  const d = await a.write(charter.resolve("p.send"), "", "q");
  assert.match(d.id, /^[0-9a-f-]{36}$/, "fell back to our own messageId");
  assert.equal(d.url.includes("\u001b"), false);
});

test("a2a: a JSON-RPC error is surfaced, and a plain Message result is read as the reply", async () => {
  const charter = charterFor("| peer | a2a | https://peer.example |", "| p.send | peer | send | speak | out | human-agent | — |\n| p.replies | peer | replies | listen | in | agent-human | — |");
  let fail = true;
  const { fetch } = fakeFetch([
    [/agent-card/, () => ({ body: { name: "P", url: "https://peer.example/rpc" } })],
    [/\/rpc$/, (c) => ({ body: fail ? { jsonrpc: "2.0", id: c.body.id, error: { code: -32001, message: "busy" } } : { jsonrpc: "2.0", id: c.body.id, result: { kind: "message", role: "agent", parts: [{ type: "text", text: "v0.2-style part" }] } } })],
  ]);
  const a = new A2AAdapter({ platform: charter.platform("peer"), credentials: null, fetch });
  await assert.rejects(() => a.write(charter.resolve("p.send"), "", "x"), /error -32001: busy/);
  fail = false;
  await a.write(charter.resolve("p.send"), "", "x");
  const r = await a.read(charter.resolve("p.replies"));
  assert.equal(r[r.length - 1].body, "v0.2-style part");
});

// ---------------------------------------------------------------------------
// discord
// ---------------------------------------------------------------------------

test("discord: a code fence cut by a chunk boundary is closed and reopened, so the footer never renders as code", () => {
  const body = "Intro\n\n```ts\n" + "const x = 1;\n".repeat(200) + "```\n\nOutro\n\n---\n*Relayed by The Embassy · crossing `abc` · ledger #3 deadbeef0000*";
  const parts = chunk(body);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.length <= 2000, "within the limit after balancing");
    const fences = (p.match(/^\s*```/gm) || []).length;
    assert.equal(fences % 2, 0, `every chunk has balanced fences: ${fences}`);
  }
  const last = parts[parts.length - 1];
  assert.match(last, /\*Relayed by The Embassy[^]*\*$/, "footer is last");
  assert.equal(/```[^]*Relayed by The Embassy/.test(last.slice(last.lastIndexOf("```") + 3)), false, "footer is outside any fence");
  assert.ok(parts[1].startsWith("```ts\n"), "the continuation reopens the fence with its language");
});

test("discord: ~~~ fences and 4-backtick fences are balanced with their own character and length; inline spans are not fences", () => {
  const tilde = "Intro\n\n~~~\n" + "row\n".repeat(600) + "~~~\n\n---\n*Relayed by The Embassy · crossing `abc` · ledger #3 dead*";
  const parts = chunk(tilde);
  for (const p of parts) assert.equal(((p.match(/^~~~/gm) || []).length) % 2, 0, "tilde fences balanced");
  assert.match(parts[parts.length - 1], /\*Relayed by The Embassy[^]*\*$/);
  assert.equal(parts[parts.length - 1].includes("~~~\n\n---"), true, "footer follows the closing fence");

  const four = "````md\n" + "x\n".repeat(1200) + "````\n\nfooter";
  const p4 = chunk(four);
  assert.ok(p4[1].startsWith("````md\n"), "reopened with four backticks and the info string");
  assert.match(p4[0], /````\s*$/, "closed with four, not three");

  const spans = ("```a``` inline\n" + "text\n".repeat(500)) + "\n---\n*Relayed by The Embassy · crossing `abc` · ledger #3 dead*";
  const ps = chunk(spans);
  assert.equal(ps.some((p) => /^```\s*$/m.test(p)), false, "no spurious closers were injected");
});

test("discord: chunking splits at paragraphs, never truncates, footer lands in the last chunk", () => {
  assert.deepEqual(chunk("short"), ["short"]);
  const para = "A".repeat(1500) + "\n\n" + "B".repeat(1500) + "\n\n---\n*footer*";
  const parts = chunk(para);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith("A") && parts[0].length <= 2000);
  assert.ok(parts[1].endsWith("*footer*"));
  assert.equal(parts.join("\n\n").replace(/\n+/g, "\n"), para.replace(/\n+/g, "\n"), "nothing lost");
  const wall = "x".repeat(4500);
  assert.equal(chunk(wall).join(""), wall);
});

test("discord: reads oldest-first, posts with mentions disabled and chunked, replies with a message_reference, Bot auth", async () => {
  const charter = charterFor("| discord | discord | https://discord.com/api/v10 |", "| d.ch | discord | 123456789012345678 | both | both | agent-human | — |");
  let n = 0;
  const { fetch, calls } = fakeFetch([
    [/\/messages\?limit=/, () => ({ body: [{ id: "2", content: "newer", author: { username: "b" }, timestamp: "2026-09-12T02:00:00Z", guild_id: "g" }, { id: "1", content: "older", author: { global_name: "A", username: "a" }, timestamp: "2026-09-12T01:00:00Z" }] })],
    [/\/messages$/, () => ({ body: { id: `m${++n}`, guild_id: "g" } })],
    [/\/users\/@me/, () => ({ body: { username: "embassy-bot" } })],
  ]);
  const a = new DiscordAdapter({ platform: charter.platform("discord"), credentials: { token: "T" }, fetch });
  const msgs = await a.read(charter.resolve("d.ch"));
  assert.equal(calls[0].headers.Authorization, "Bot T");
  assert.deepEqual(msgs.map((m) => m.body), ["older", "newer"]);
  assert.equal(msgs[0].author, "A");
  assert.equal(msgs[1].url, "https://discord.com/channels/g/123456789012345678/2");

  const d = await a.write(charter.resolve("d.ch"), "Title", "P1".padEnd(1900, ".") + "\n\n" + "P2".padEnd(1900, ".") + "\n\n---\n*footer*");
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  assert.match(posts[0].body.content, /^\*\*Title\*\*/);
  assert.match(posts[1].body.content, /\*footer\*$/);
  assert.equal(d.id, "m1+m2");
  assert.equal(d.url, "https://discord.com/channels/g/123456789012345678/m2");

  await a.reply(charter.resolve("d.ch"), "1", "r");
  assert.deepEqual(calls[calls.length - 1].body.message_reference, { message_id: "1" });
  assert.match((await a.check()).detail, /embassy-bot/);
});

test("discord: the base must be discord.com; a non-numeric channel is refused", async () => {
  const charter = charterFor("| discord | discord | https://discord.com/api/v10 |", "| d.ch | discord | 123456789012345678 | both | both | agent-human | — |");
  assert.throws(() => new DiscordAdapter({ platform: { id: "discord", adapter: "discord", base: "https://evil.example/api/v10" }, credentials: { token: "T" }, fetch: fakeFetch([]).fetch }), /base must be/);
  const a = new DiscordAdapter({ platform: charter.platform("discord"), credentials: null, fetch: fakeFetch([]).fetch });
  delete process.env.DISCORD_BOT_TOKEN;
  await assert.rejects(() => a.read(charter.resolve("d.ch")), NotConfigured);
});

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

test("console: inboxes are keyed by platform alias AND channel, so two console aliases with channel 'inbox' do not share a file", async () => {
  const { ConsoleAdapter } = await import("./adapters/console");
  const charter = charterFor("| local | console | — |", "| a.in | local | inbox | listen | in | human-agent | — |\n| b.in | console | inbox | listen | in | human-agent | — |");
  ConsoleAdapter.queue(charter.resolve("a.in"), { author: "h", body: "for a" });
  const a = new ConsoleAdapter({ platform: "local", quiet: true });
  const b = new ConsoleAdapter({ platform: "console", quiet: true });
  assert.equal((await a.read(charter.resolve("a.in"))).length, 1);
  assert.equal((await b.read(charter.resolve("b.in"))).length, 0);
});

test("credentials: the legacy credentials.json is offered only to a 'moltbook' alias whose base really is www.moltbook.com", async () => {
  const { loadCredentials } = await import("./credentials");
  const dir = path.join(process.env.HOME!, ".config", "embassy");
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, "credentials", "moltbook.json"), { force: true }); // a per-alias file always wins; remove the one an earlier test saved
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ api_key: "legacy-key" }));
  assert.equal(loadCredentials("moltbook", "https://www.moltbook.com/api/v1")?.api_key, "legacy-key");
  assert.equal(loadCredentials("moltbook", "https://www.moltbook.com.evil.tld/api/v1"), null);
  assert.equal(loadCredentials("moltbook", null), null);
  assert.equal(loadCredentials("clawk", "https://www.moltbook.com/api/v1"), null);
  assert.throws(() => loadCredentials("../x"), /invalid platform id/);
  fs.rmSync(path.join(dir, "credentials.json"));
});

test("the factory builds one adapter per platform row, keyed by alias, with the alias's credentials", () => {
  const charter = charterFor(
    "| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |\n| clawk | molt/clawk | https://clawk.ai/api/v1 |\n| peer | a2a | https://peer.example |",
    "| m.hot | moltbook | posts?sort=hot | listen | in | agent-human | — |"
  );
  const built = charter.platforms().map((p) => buildAdapter(p, { fetch: fakeFetch([]).fetch, quiet: true }));
  assert.deepEqual(built.map((a) => [a.platform, a.kind]), [["moltbook", "molt/moltbook"], ["clawk", "molt/clawk"], ["peer", "a2a"], ["console", "console"]]);
  assert.throws(() => buildAdapter({ id: "x", adapter: "nope", base: "https://x" } as any, {}), AdapterError);
});
