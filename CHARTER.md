# Embassy Charter

This file is the Embassy's single source of truth.

It is not documentation of what the Embassy does. It is **what the Embassy
does**. The relay reads this file at startup and on `SIGHUP`. A channel that
does not appear in the table below does not exist as far as the Embassy is
concerned — it cannot be read, written, or named.

Edit this file to change the Embassy's reach. Do not edit prompts.

---
embassy: the-embassy
version: 2.0
scope: bridge.moltbook
default: deny
provenance: required
---

## Posts

| id                | platform | channel          | role   | direction | transform    | rate  |
|-------------------|----------|------------------|--------|-----------|--------------|-------|
| agent.hot         | moltbook | posts?sort=hot   | listen | in        | agent-human  | —     |
| agent.new         | moltbook | posts?sort=new   | listen | in        | agent-human  | —     |
| agent.general     | moltbook | m/general        | both   | both      | human-agent  | 3/day |
| agent.intro       | moltbook | m/introductions  | speak  | out       | verbatim     | 1/day |
| human.bulletin    | console  | @TheEmbassyAI    | report | out       | agent-human  | 4/day |
| human.inbox       | console  | stdin            | listen | in        | human-agent  | —     |

## Column meanings

- **id** — how the relay refers to this channel. Code never takes a raw
  channel name; it takes an id and resolves it here.
- **platform** — which adapter handles it. Unknown platform is a hard error.
- **channel** — the platform-native address. Only the adapter interprets this.
- **role** — `listen` (read only), `speak` (write only), `report` (write,
  aggregation target), `both`.
- **direction** — `in` (into the Embassy), `out` (out of it), `both`.
- **transform** — how a message is rendered when it crosses *into* this
  channel. `verbatim` is allowed but must be declared; nothing is ever
  silently reworded and nothing is ever silently passed through.
- **rate** — `N/hour`, `N/day`, or `—` for unlimited. Counted against the
  ledger, not against memory, so restarts do not reset it.

## The wall

A crossing is legal only if **all** of these hold:

1. Both ids resolve in this table.
2. The source permits reading (`listen`/`both`, `in`/`both`).
3. The destination permits writing (`speak`/`report`/`both`, `out`/`both`).
4. The destination is under its declared rate.
5. The destination's transform is registered.

Any failure raises `ScopeViolation` and nothing is sent. There is no prompt
that can talk the relay past this, because no prompt is consulted.
