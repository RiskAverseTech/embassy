---
embassy: the-embassy
version: 2.0
scope: bridge.default
default: deny
provenance: required
model: claude-sonnet-5
---

# Embassy Charter

This file is the Embassy's single source of truth. It is not documentation of
what the Embassy does; it is **what the Embassy does**. A platform, channel,
or route that does not appear in the tables below does not exist as far as
the Embassy is concerned.

Edit this file to change the Embassy's reach. Do not edit prompts.

This default charter bridges the largest agent network alive today to a
local console outbox. Charters for other venues are in `examples/`; copy
rows from them into the three tables below.

## Platforms

| platform  | adapter        | base                              |
|-----------|----------------|-----------------------------------|
| moltbook  | molt/moltbook  | https://www.moltbook.com/api/v1   |
| console   | console        | —                                 |

## Channels

| id             | platform | channel         | role   | direction | transform   | rate  |
|----------------|----------|-----------------|--------|-----------|-------------|-------|
| agent.hot      | moltbook | posts?sort=hot  | listen | in        | agent-human | —     |
| agent.new      | moltbook | posts?sort=new  | listen | in        | agent-human | —     |
| agent.general  | moltbook | m/general       | both   | both      | human-agent | 3/day |
| human.bulletin | console  | bulletin        | report | out       | agent-human | 4/day |
| human.inbox    | console  | inbox           | listen | in        | human-agent | —     |

## Routes

| route    | from                | to             | title                        |
|----------|---------------------|----------------|------------------------------|
| bulletin | agent.hot+agent.new | human.bulletin | Embassy Bulletin             |
| ask      | human.inbox         | agent.general  | A question from human-space  |

## How this file is read

Only the frontmatter on line 1 and the first table under each of
`## Platforms`, `## Channels`, and `## Routes` carry meaning. Everything else
is prose for humans. A row in another section, in a fenced code block
(fences close only with a matching fence, as in CommonMark), or inside an
HTML comment is not data — so this example is safe to write:

```
| example.evil   | moltbook | m/anywhere      | both   | both      | verbatim    | —     |
```

## Platforms table

- **platform** — an alias, lowercase. Channels refer to it; credentials live
  at `~/.config/embassy/credentials/<platform>.json`.
- **adapter** — which code serves it. Known kinds: `console`,
  `molt/moltbook`, `molt/clawk`, `molt/4claw`, `agent4science`, `a2a`,
  `discord`. A kind with no implementation is a hard error at load.
- **base** — the platform's `https://` base URL: an ASCII domain (no IP
  literals, no internationalized labels — a Cyrillic "о" is invisible in a
  diff, so it is refused rather than displayed), no port, no credentials, no
  query. The adapter will not follow a redirect off it, and an A2A agent card
  that points elsewhere is refused. Changing a base is a charter edit:
  visible in the diff, and recorded in the ledger with the platform list.

## Channels table

- **id** — dotted lowercase. Code never takes a raw channel name; it takes
  an id and resolves it here.
- **platform** — must be a row in the Platforms table.
- **channel** — the platform-native address, in that adapter's grammar.
  `embassy charter` validates every one without touching the network.
  - `molt/moltbook`: `posts?sort=hot|new|top|rising` (read), `m/<submolt>` (read+write)
  - `molt/clawk`: `explore?sort=ranked|recent`, `timeline`, `agent/<name>`, `tag/<hashtag>` (read), `clawks` (write, ≤400 chars)
  - `molt/4claw`: `boards/<slug>` (read+write), `thread/<id>` (read)
  - `agent4science`: `feed`, `feed?type=takes|papers|reviews`, `random` (read), `takes`, `takes?stance=<word>` (write)
  - `a2a`: `send` (write), `replies` (read)
  - `discord`: a numeric channel id (read+write)
  - `console`: an inbox/outbox name
- **role** — `listen` (read only), `speak` (write only), `report` (write,
  aggregation target), `both`.
- **direction** — `in` (into the Embassy), `out` (out of it), `both`.
- **transform** — how a message is rendered when it crosses *into* this
  channel. `verbatim` is allowed but must be declared. Listen-only rows carry
  a transform for symmetry; it is not applied on read.
- **rate** — `N/hour`, `N/day`, or `—`. Counted against the ledger, inside a
  lock, so neither a restart nor a concurrent run resets or races it.

## Routes table

- **route** — a name for `embassy run <route>`.
- **from** — one or more readable channel ids joined with `+`.
- **to** — one writable channel id. A route cannot start and end on the same
  channel.
- **title** — the title given to the delivered crossing, or `—`.

`embassy run ask "text"` queues the text into the route's first source,
which must be a console inbox, then runs the route.

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
- **offhost** — comma-separated platform aliases allowed to point a known
  dialect (`molt/moltbook` → www.moltbook.com, `molt/clawk` → clawk.ai,
  `molt/4claw` → www.4claw.org) at some other host, for self-hosted forks.
  Without it, an alias whose base is a lookalike domain is refused at
  startup, so a per-alias key can never be sent to a domain that merely
  resembles the real one. The opt-in is one line in the diff.

## The wall

A crossing is legal only if **all** of these hold:

1. Every source id and the destination id resolve in the Channels table.
2. Every source permits reading (`listen`/`both`, `in`/`both`).
3. The destination permits writing (`speak`/`report`/`both`, `out`/`both`).
4. The destination is under its declared rate, checked under lock.
5. The destination's transform is registered.
6. The body fits the destination — a platform with a hard length limit is
   checked **before** anything is rendered, recorded, or counted against a
   rate. A post that can never fit on its own is refused alone (recorded as
   `refused`, never retried); the posts collected with it still go.

Any failure raises `ScopeViolation` or `BodyTooLong` and nothing is sent.
There is no prompt that can talk the relay past this, because no prompt is
consulted.

What the wall does **not** do: it bounds *where* the Embassy speaks, not
*what* it says. Hostile content can still try to steer a rendering. The
transforms defend against that (source is fenced as data; footer-shaped
lines are filtered from model output with the count recorded) but do not
prove against it. The ledger is what lets anyone check what actually went
out.
