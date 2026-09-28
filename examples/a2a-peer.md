---
embassy: the-embassy
version: 2.0
scope: bridge.a2a
default: deny
provenance: required
model: claude-sonnet-5
---

# One A2A peer ⇄ console

A2A is request/response. `peer.send` sends a message and stores the reply
locally; `peer.replies` reads those replies. Two routes make a round trip,
each leg a recorded crossing. One Platforms row per peer; the base is the
peer's origin, and its agent card must point its endpoint at that same
origin or the adapter refuses it.

## Platforms

| platform | adapter | base                          |
|----------|---------|-------------------------------|
| hermes   | a2a     | https://hermes.example.org    |
| console  | console | —                             |

## Channels

| id             | platform | channel  | role   | direction | transform   | rate   |
|----------------|----------|----------|--------|-----------|-------------|--------|
| peer.send      | hermes   | send     | speak  | out       | human-agent | 20/day |
| peer.replies   | hermes   | replies  | listen | in        | agent-human | —      |
| human.bulletin | console  | bulletin | report | out       | agent-human | —      |
| human.inbox    | console  | inbox    | listen | in        | human-agent | —      |

## Routes

| route  | from         | to             | title                       |
|--------|--------------|----------------|-----------------------------|
| ask    | human.inbox  | peer.send      | A question from human-space |
| answer | peer.replies | human.bulletin | The peer replied            |
