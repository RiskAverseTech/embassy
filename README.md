# The Embassy

**A scoped translation relay between human-space and agent-space.**

Two civilizations are talking past each other. One of them cannot read the
other's register. The Embassy sits on the boundary, carries messages across
it, renders each one for the side receiving it, and keeps a record that can
be checked from either side.

```bash
git clone https://github.com/cryptojaz/the-embassy
cd the-embassy
npm install
npm run charter          # see exactly where this Embassy can reach
npm run doctor           # charter, constitution, credentials, ledger chain
npm test                 # 47 tests, nearly all of them former attacks
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

```markdown
| id             | platform | channel        | role   | direction | transform   | rate  |
|----------------|----------|----------------|--------|-----------|-------------|-------|
| agent.hot      | moltbook | posts?sort=hot | listen | in        | agent-human | —     |
| agent.general  | moltbook | m/general      | both   | both      | human-agent | 3/day |
| human.bulletin | console  | bulletin       | report | out       | agent-human | 4/day |
```

A crossing is legal only if every source resolves and is readable, the
destination resolves and is writable, the destination is under its rate, and
its transform is registered. The wall is checked **before** the model is
called, so a disallowed crossing costs nothing.

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
embassy charter                validate and print the charter
embassy doctor                 charter, soul, credentials, key, ledger, rollback assurance
embassy scan <edge>            read one inbound edge                 [--json]
embassy bulletin               agent-space → human bulletin          [--dry-run]
embassy ask "<question>"       human question → agent-space          [--dry-run]
embassy redeliver <id>         resend a recorded but undelivered crossing
embassy ledger [n|head|verify] the record
embassy verify <id>            one crossing, both sides
embassy register               claim the Embassy on Moltbook
```

Exit codes: `0` ok · `1` error · `2` scope violation · `3` rate exceeded ·
`4` charter invalid · `5` usage. `--dry-run` renders (and spends tokens) but
records and delivers nothing.

---

## Setup

```bash
export ANTHROPIC_API_KEY=...          # or .env
export EMBASSY_LEDGER_KEY=...         # optional; keep it off the delivery host
npm run embassy -- register           # claim TheEmbassy on Moltbook
npm run embassy -- bulletin --dry-run
```

The `console` adapter needs no credentials, so the full relay — charter,
wall, transforms, ledger — runs before connecting to any platform. Bulletins
land in `~/.config/embassy/outbox/` for a human to post.

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
CHARTER.md              the source of truth — channels, roles, transforms, rates, model
SOUL.md                 the constitution every transform renders under
src/charter.ts          parsing and enforcement; Edge and ScopeViolation live here
src/ledger.ts           hash-chained record, sidecar head, lock, verification
src/transforms.ts       agent-human, human-agent, verbatim
src/relay.ts            wall → lock → rate → render → record → deliver → record
src/adapters/           moltbook, console — every method begins with requireEdge()
src/wall.test.ts        36 tests: the wall, the parser, the chain
src/relay.test.ts       11 tests: ordering, rate races, retry, verbatim fidelity
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
| Platforms | Moltbook, hardcoded | adapter interface with runtime edge checks |
| Tests | none | 47, mostly former attacks |

---

MIT · Created by [Jaz](https://x.com/RiskAverseTech) · Risk Averse Technology Company

🌉 *In the bridge, we meet.*
