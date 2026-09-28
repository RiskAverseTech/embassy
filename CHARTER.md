---
embassy: the-embassy
version: 2.0
scope: bridge.moltbook
default: deny
provenance: required
model: claude-sonnet-4-20250514
---

# Embassy Charter

This file is the Embassy's single source of truth. It is not documentation of
what the Embassy does; it is **what the Embassy does**. A channel that does
not appear in the table under `## Channels` does not exist as far as the
Embassy is concerned — it cannot be read, written, or named.

Edit this file to change the Embassy's reach. Do not edit prompts.

## Channels

| id             | platform | channel         | role   | direction | transform   | rate  |
|----------------|----------|-----------------|--------|-----------|-------------|-------|
| agent.hot      | moltbook | posts?sort=hot  | listen | in        | agent-human | —     |
| agent.new      | moltbook | posts?sort=new  | listen | in        | agent-human | —     |
| agent.general  | moltbook | m/general       | both   | both      | human-agent | 3/day |
| agent.intro    | moltbook | m/introductions | speak  | out       | verbatim    | 1/day |
| human.bulletin | console  | bulletin        | report | out       | agent-human | 4/day |
| human.inbox    | console  | inbox           | listen | in        | human-agent | —     |

## How this file is read

Only two parts of this file carry meaning: the frontmatter on line 1, and the
first table under the `## Channels` heading. Everything else is prose for
humans. A row in another section, in a fenced code block, or after a second
heading is not an edge — so an example like the one below is safe to write:

```
| example.evil   | moltbook | m/anywhere      | both   | both      | verbatim    | —     |
```

The frontmatter must be the first thing in the file. A `---` rule elsewhere
is just a rule.

## Columns

- **id** — how the relay refers to this channel. Dotted lowercase. Code never
  takes a raw channel name; it takes an id and resolves it here.
- **platform** — which adapter handles it. A platform with no adapter is a
  hard error at startup, not at first use.
- **channel** — the platform-native address, in that adapter's grammar.
  Moltbook: `posts?sort=hot|new|top` (a feed, read-only) or `m/<submolt>`.
  Console: an inbox/outbox name.
- **role** — `listen` (read only), `speak` (write only), `report` (write,
  aggregation target), `both`.
- **direction** — `in` (into the Embassy), `out` (out of it), `both`.
- **transform** — how a message is rendered when it crosses *into* this
  channel. `verbatim` is allowed but must be declared; nothing is ever
  silently reworded and nothing is ever silently passed through. Listen-only
  rows carry a transform for symmetry; it is not applied on read.
- **rate** — `N/hour`, `N/day`, or `—`. Counted against the ledger, inside a
  lock, so neither a restart nor a concurrent run resets or races it.

## Frontmatter

- **default** — must be `deny`. Anything else and the Embassy refuses to open.
- **provenance** — `required` (default) appends a footer to every delivery
  naming the crossing id and the ledger head at that moment. That footer is
  the anchor that makes the ledger tamper-evident: it lives on the other side
  of the boundary. `optional` turns it off, and with it the anchoring.
- **model** — the model every transform renders with. Changing it is a
  charter edit, visible in the diff, and recorded on every crossing.
- **endpoint** — optional `https://` base URL for the model API. Absent, the
  Embassy pins the public endpoint; the environment cannot redirect it.

## The wall

A crossing is legal only if **all** of these hold:

1. Every source id and the destination id resolve in this table.
2. Every source permits reading (`listen`/`both`, `in`/`both`).
3. The destination permits writing (`speak`/`report`/`both`, `out`/`both`).
4. The destination is under its declared rate, checked under lock.
5. The destination's transform is registered.

Any failure raises `ScopeViolation` and nothing is sent. There is no prompt
that can talk the relay past this, because no prompt is consulted.

What the wall does **not** do: it bounds *where* the Embassy speaks, not
*what* it says. Hostile content can still try to steer a rendering. The
transforms defend against that (source is fenced as data; footer-shaped lines
are stripped) but do not prove against it. The ledger is what lets anyone
check what actually went out.
