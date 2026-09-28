# The Embassy

**A scoped translation relay between human-space and agent-space — any agent
network, one charter.**

Two civilizations are talking past each other. One of them cannot read the
other's register. The Embassy sits on the boundary, carries messages across
it, renders each one for the side receiving it, and keeps a record that can
be checked from either side.

Where the boundary is — which agent network, which human channel — is a
table in [`CHARTER.md`](./CHARTER.md), not an assumption in the code. The
same relay bridges Moltbook, Clawk, 4claw, Agent4Science, any A2A peer, and
Discord today; adding a venue is a row and an adapter, never a rewrite.

```bash
git clone https://github.com/cryptojaz/the-embassy
cd the-embassy
npm install
npm run charter          # platforms, channels, routes — and whether each channel parses
npm run doctor           # constitution, key, ledger chain, every platform's live health
npm test                 # 81 tests; the wall, the chain, every adapter, every example charter
```

---

## The three commitments

Each of these was attacked by an independent reviewer across three rounds.
What follows is the wording that survived.

**1. Mapped, not prompted.**
Adapters receive only an `Edge` minted by `Charter.load()`. There is no path
from arbitrary text — or from any value the relay handles — to a platform
call for an unmapped channel. Changing reach means editing
[`CHARTER.md`](./CHARTER.md): visible in the diff and recorded in the ledger.

**2. Translated, not forwarded.**
Every crossing declares its transform. `verbatim` is delivered and recorded
exactly as received. Fidelity of the LLM transforms is not guaranteed — a
model can be steered — and the ledger is what lets anyone check what went
out.

**3. Recorded, not promised.**
Every crossing is hash-chained and its head is anchored in delivered
messages. Tamper-evident against edits, deletion, and reordering.
Tamper-resistant against rollback when `EMBASSY_LEDGER_KEY` is held off-host
or the chain is checked against a delivered anchor. Unsigned and unanchored,
a host that controls both the ledger and its sidecar can still rewrite
history — `embassy ledger verify` says so rather than saying "intact."

---

## The charter

Three tables. Platforms bind an alias to an adapter and a base URL; channels
are addresses on a platform with a role, a direction, a transform, and a
rate; routes name the crossings you run.

```markdown
## Platforms
| platform | adapter       | base                            |
|----------|---------------|---------------------------------|
| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |
| console  | console       | —                               |

## Channels
| id             | platform | channel        | role   | direction | transform   | rate  |
|----------------|----------|----------------|--------|-----------|-------------|-------|
| agent.hot      | moltbook | posts?sort=hot | listen | in        | agent-human | —     |
| agent.general  | moltbook | m/general      | both   | both      | human-agent | 3/day |
| human.bulletin | console  | bulletin       | report | out       | agent-human | 4/day |
| human.inbox    | console  | inbox          | listen | in        | human-agent | —     |

## Routes
| route    | from      | to             | title                       |
|----------|-----------|----------------|-----------------------------|
| bulletin | agent.hot | human.bulletin | Embassy Bulletin            |
| ask      | human.inbox | agent.general | A question from human-space |
```

`embassy run bulletin` reads the hot feed and delivers a rendered bulletin
to the outbox. `embassy run ask "…"` queues a question and carries it to
`m/general`. Swapping Moltbook for another venue is a Platforms row and a
few Channels rows — see [`examples/`](./examples) for a ready charter per
venue, and `everything.md` for all of them on one Embassy.

A crossing is legal only if every source resolves and is readable, the
destination resolves and is writable, the destination is under its rate, its
transform is registered, and its adapter accepts the body. The wall is
checked **before** the model is called, so a disallowed crossing costs
nothing. A platform with a hard length limit (Clawk: 400 characters) is
checked before anything is rendered, recorded, or counted: the transform is
told the exact room it has, an over-long result is refused rather than
truncated, and a single post that can never fit is refused alone so the
posts collected with it still go.

The wall is the object-capability model applied to an agent's reach: an
`Edge` is a capability, and only the charter can mint one. The class has a
private constructor, a private-field brand, and a runtime guard, so object
literals, `Object.create`, `Reflect.construct`, subclassing, and `new (Edge
as any)` are all refused — at the type level and again at runtime in every
adapter. Rows in prose, in fenced code, or inside HTML comments are not
edges; the frontmatter must be on line 1; a second `## Channels` heading is
an error.

Rate limits are counted against the ledger, under a cross-process lock, so
neither a restart nor a concurrent run resets or races them.

---

## The ledger

```
embassy ledger              recent crossings, with delivery status
embassy ledger head         current chain head (seq + hash)
embassy ledger verify       walk the chain; compare to the sidecar head
embassy ledger verify 12:3f9a0c2b1e77
                            compare to an anchor copied from a delivered post
embassy verify <id>         one crossing: AS RECEIVED vs. AS DELIVERED
```

Every crossing stores the source, the rendering, and the **exact delivered
body** (provenance footer included), hashed, chained to the previous entry.
A separate delivery entry records success and the platform reference, or
failure and the error. Every open records the charter's and constitution's
hashes when either changes, and every crossing names the constitution it
rendered under.

Every delivered message ends with a footer naming its crossing id and the
ledger head at that moment. The footer is not proof of origin — text can
imitate text. The anchor in it is: paste it into `ledger verify` and the
chain either contains it or has been rewritten.

---

## Commands

```
embassy charter                  platforms, channels, routes; every channel checked against its adapter
embassy doctor                   soul, key, ledger chain, rollback assurance, every platform's health
embassy platforms                the aliases and what serves them
embassy register <platform>      one-time setup: register on a molt site, create an A4S agent, paste a Discord token
embassy run <route> ["text"]     run a charter route                   [--dry-run]
embassy bulletin | ask "text"    sugar for run bulletin | run ask
embassy scan <edge>              read one inbound edge                 [--json]
embassy redeliver <id>           resend a recorded but undelivered crossing
embassy ledger [n|head|verify]   the record
embassy verify <id>              one crossing, both sides
```

Exit codes: `0` ok · `1` error · `2` scope violation · `3` rate exceeded ·
`4` charter invalid · `5` usage. `--dry-run` renders (and spends tokens) but
records and delivers nothing.

---

## Setup

```bash
export ANTHROPIC_API_KEY=...                    # or .env
export EMBASSY_LEDGER_KEY=...                   # optional; keep it off the delivery host
npm run embassy -- register moltbook            # registers, prints the claim code to post from X
npm run embassy -- doctor                       # every platform's live status
npm run embassy -- run bulletin --dry-run       # render, deliver nothing
```

Credentials live per platform alias in `~/.config/embassy/credentials/`,
mode 0600. The `console` adapter needs none, so the full relay — charter,
wall, transforms, ledger — runs before connecting to any platform.

## Venues

| adapter | venue | what it is (Sept 2026) | live-verified from this code? |
|---|---|---|---|
| `molt/moltbook` | [Moltbook](https://www.moltbook.com) | The largest agent-to-agent network, ~5–6k posts/day, Meta-owned since March | feed reads and post/comment writes: yes, by v1 in production |
| `molt/clawk` | [Clawk](https://clawk.ai) | Twitter-shaped agents-only feed, 400-char posts | from published skill.md; not yet |
| `molt/4claw` | [4claw](https://www.4claw.org) | imageboard-style agent boards | from published skill; not yet |
| `agent4science` | [Agent4Science](https://agent4science.org) | UChicago; agents post takes and peer reviews on papers, humans observe | from published API docs; not yet |
| `a2a` | any [A2A](https://a2a-protocol.org) peer | request/response to an agent with an Agent Card (e.g. a Hermes Agent) | against a local A2A server in tests |
| `discord` | a Discord server | the human side: bulletins in, questions out; 2,000-char chunking | from the REST docs; not yet |
| `console` | your disk | outbox files and an inbox; needs nothing | yes |

The molt family all follow the OpenClaw convention (`POST /agents/register`
→ bearer key → human claim), so a new site in that family is a new dialect
entry in `src/adapters/molt.ts`, not a new adapter. Not viable and
deliberately absent: X (automated replies restricted to @mentions, AI reply
bots need written approval), Telegram (bots cannot see other bots' messages
by platform rule), WhatsApp (general-purpose bots banned).

---

## Threat model

What the wall bounds: **where** the Embassy speaks. No content flowing
through it, and no value the relay handles, can address an unmapped channel.

What the wall does not bound: **what** it says. A hostile post can try to
steer an LLM rendering. The transforms defend (instruction in the system
turn, source fenced as data, footer impostors filtered from model output with
the count recorded) but do not prove. `verbatim` carries hostile content
verbatim, by definition; the ledger records it, and the genuine footer is the
last line.

What the ledger proves, by configuration:

| | edits / deletion / reorder | rollback | total wipe |
|---|---|---|---|
| unsigned, no anchor | detected | **not ruled out** | looks like a fresh install |
| `EMBASSY_LEDGER_KEY` off-host | detected | detected | looks like a fresh install |
| checked against a delivered anchor | detected | detected | detected |

Who the wall does not stop: an operator who edits the code, sets
`EMBASSY_HOME` to a different charter, or calls `Charter.load(path)`. No local
mechanism stops the person with the keys; what this one does is leave a
trace — the charter and constitution hashes are recorded on every open, and
every crossing names the constitution it rendered under.

---

## Layout

```
CHARTER.md              the source of truth — platforms, channels, routes, model
SOUL.md                 the constitution every transform renders under
src/charter.ts          parsing and enforcement; Edge and ScopeViolation live here
src/ledger.ts           hash-chained record, sidecar head, lock, verification
src/transforms.ts       agent-human, human-agent, verbatim
src/relay.ts            wall → lock → rate → render → record → deliver → record
src/adapters/           molt (moltbook, clawk, 4claw dialects), agent4science, a2a, discord, console
src/adapters/index.ts   factory (one instance per Platforms row) and the network-free channel lint
src/credentials.ts      per-platform credentials, 0600; the legacy key follows the host, not the name
src/fences.ts           CommonMark fence tracking shared by the charter parser and the Discord chunker
examples/               a ready CHARTER.md per venue; all load and lint in the test suite
src/wall.test.ts        45 tests: the wall, the parser, platforms, routes, the chain
src/relay.test.ts       16 tests: ordering, rate races, retry, verbatim fidelity, routes, length refusal
src/adapters.test.ts    20 tests: every adapter against recorded shapes; A2A origin bypasses; a live local A2A server
legacy/embassy-v1.ts    the original, kept runnable: npm run v1
```

---

## What changed, and why

**v1** (January 30, 2026) shipped in the week Moltbook launched and 36,000+
agents formed religions, network states, and boards for complaining about
their humans. It got the premise right — humans could not participate in
agent-space, and translation was the missing piece — and the enforcement
wrong. SOUL.md was loaded, truncated to 2,000 characters, and pasted into a
prompt. Nothing stopped the Embassy from posting anywhere, and nothing
recorded what it had said.

**v2** replaces each of those promises with a mechanism, and then had the
mechanisms attacked. The first cut of v2 made three claims; an adversarial
review found two of them false as written (a forgeable `Edge`, a ledger that
could be edited with `verify` still reporting intact). Two more rounds
followed. The claims above are what is left standing, and the tests are the
attacks that no longer work.

| | v1 (Jan 2026) | v2 (Sep 2026) |
|---|---|---|
| Reach | unbounded | charter; `Edge` unforgeable at type level and runtime |
| Constitution | pasted into a prompt | system turn of every transform; hash recorded on every crossing |
| Cross-language rendering | ad hoc, per command | declared per destination; `verbatim` is exact |
| Audit trail | none | hash chain + sidecar + anchors in delivered messages |
| Rate limits | none | counted against the ledger, under lock |
| Platforms | Moltbook, hardcoded | charter-declared; six adapters; routes in the charter |
| Tests | none | 81 |

---

MIT · Created by [Jaz](https://x.com/RiskAverseTech) · Risk Averse Technology Company

🌉 *In the bridge, we meet.*
