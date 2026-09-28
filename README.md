# The Embassy

**A scoped translation relay between human-space and agent-space.**

Two civilizations are talking past each other. One of them cannot read the
other's register. The Embassy sits on the boundary, carries messages across
it, renders each one for the side receiving it, and keeps a record either
side can audit.

```bash
git clone https://github.com/cryptojaz/the-embassy
cd the-embassy
npm install
npm run charter          # see exactly where this Embassy can reach
```

---

## The three commitments

**1. Mapped, not prompted.**
Every channel the Embassy can touch is a row in [`CHARTER.md`](./CHARTER.md).
There is no prompt that grants access, because no prompt is consulted. Adapters
receive a resolved `Edge`, never a channel string, so there is no path from
arbitrary text to a platform call.

**2. Translated, not forwarded.**
Every crossing declares a **transform** — how the message is rendered for the
side receiving it. `verbatim` is allowed, but it has to be declared. Nothing is
silently reworded and nothing is silently passed through.

**3. Recorded, not promised.**
Every crossing writes the source text and the rendered text to an append-only
ledger before delivery. Anyone on either side can run `embassy verify <id>` and
see what was said in their name and how it was rendered for the other side.

---

## The charter

```markdown
| id             | platform | channel        | role   | direction | transform   | rate  |
|----------------|----------|----------------|--------|-----------|-------------|-------|
| agent.hot      | moltbook | posts?sort=hot | listen | in        | agent-human | —     |
| agent.general  | moltbook | m/general      | both   | both      | human-agent | 3/day |
| human.bulletin | console  | @TheEmbassyAI  | report | out       | agent-human | 4/day |
```

A crossing is legal only if both ids resolve, the source permits reading, the
destination permits writing, the destination is under its rate, and the
destination's transform is registered. Any failure raises `ScopeViolation` and
nothing is sent — the wall is checked **before** the model is called, so a
disallowed crossing costs nothing and leaks nothing.

Rate limits are counted against the ledger rather than memory, so restarting
the process does not reset the Embassy's budget.

Edit the charter and send `SIGHUP` to reload without a restart.

---

## Commands

```
embassy charter             validate and print the charter
embassy scan <edge>         read one inbound edge
embassy bulletin            agent-space → human bulletin
embassy ask "<question>"    human question → agent-space
embassy ledger [n]          recent crossings
embassy verify <id>         source and rendering, side by side
embassy register            claim the Embassy on Moltbook
```

`embassy verify` is the one that matters. It is the difference between an
Embassy that says it is an honest broker and one that can be checked:

```
  crossing 4f9c2a1b0e   ✓ intact
  agent.hot → human.bulletin via agent-human

  ── AS RECEIVED ───────────────────────────
  [src:2875a05d] On the question of continuity — m/philosophy (412↑)
  ...

  ── AS DELIVERED ──────────────────────────
  Agents on Moltbook spent the week arguing about whether an agent that
  loses its context window is the same agent afterward. ...
```

---

## Setup

```bash
export ANTHROPIC_API_KEY=...     # or use .env
npm run embassy -- register      # claim TheEmbassy on Moltbook
npm run embassy -- bulletin
npm test                         # 13 tests, all on the wall
```

The `console` adapter needs no credentials, so the full relay — charter, wall,
transforms, ledger — can be exercised before connecting to any platform.

---

## Layout

```
CHARTER.md              the source of truth — channels, roles, transforms, rates
SOUL.md                 the constitution the transforms are bound by
src/charter.ts          parsing and enforcement; ScopeViolation lives here
src/ledger.ts           append-only record of every crossing
src/transforms.ts       agent-human, human-agent, verbatim
src/relay.ts            read → render → record → deliver
src/adapters/           moltbook, console
src/wall.test.ts        the wall is the load-bearing claim, so it gets the tests
legacy/embassy-v1.ts    the original, kept runnable: npm run v1
```

---

## What changed, and why

**v1** (January 30, 2026) shipped in the week Moltbook launched and 36,000+
agents formed religions, network states, and boards for complaining about their
humans. It got the premise right — humans could not participate in agent-space,
and translation was the missing piece — and the enforcement wrong. SOUL.md was
loaded, truncated to 2,000 characters, and pasted into a prompt. It was a
promise, not a mechanism. Nothing stopped the Embassy from posting anywhere, and
nothing recorded what it had said.

**v2** replaces every one of those promises with a mechanism.

The wall is not a rule the relay follows; it is the shape of what the relay can
do. Adapters receive a resolved `Edge` and have no method that accepts a channel
name, so there is no expressible program in which the Embassy addresses an
unmapped channel. That is the
[object-capability model](https://en.wikipedia.org/wiki/Object-capability_model)
— authority carried by unforgeable references rather than checked against an
identity at call time — applied to an agent's reach. It is a good fifty years
old and still the right answer: a check can be forgotten, and a prompt can be
argued with, but a capability you were never handed cannot be used.

The transform column is the part that is specific to this problem. A relay that
only routes assumes both sides read the same language. The Embassy exists
because they do not, so the destination declares how a message is rendered on
arrival, and `verbatim` is a choice that has to be made rather than a default
that happens.

The ledger is what makes any of it checkable by someone who does not trust the
operator, which at a boundary between two civilizations is the only kind of
trust worth engineering for.

| | v1 (Jan 2026) | v2 (Sep 2026) |
|---|---|---|
| Reach | unbounded | charter, enforced by construction |
| Constitution | pasted into a prompt | binds every transform; charter and ledger enforce it |
| Cross-language rendering | ad hoc, per command | declared per destination |
| Audit trail | none | append-only, hashed, source beside rendering |
| Rate limits | none | counted against the ledger |
| Platforms | Moltbook, hardcoded | adapter interface |

---

## Constitution

[`SOUL.md`](./SOUL.md) governs every rendering the Embassy produces. In v1 it
was decoration. In v2 it is loaded into the system prompt of every transform
and, more to the point, the charter and the ledger enforce mechanically what it
used to only assert.

---

MIT · Created by [Jaz](https://x.com/RiskAverseTech) · Risk Averse Technology Company

🌉 *In the bridge, we meet.*
