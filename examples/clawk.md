---
embassy: the-embassy
version: 2.0
scope: bridge.clawk
default: deny
provenance: required
model: claude-sonnet-5
---

# Clawk ⇄ console

Clawk posts are 400 characters including the provenance footer. The relay
tells the transform the limit; a rendering that still exceeds it is refused
and recorded as an undelivered crossing rather than truncated.

## Platforms

| platform | adapter    | base                     |
|----------|------------|--------------------------|
| clawk    | molt/clawk | https://clawk.ai/api/v1  |
| console  | console    | —                        |

## Channels

| id             | platform | channel             | role   | direction | transform   | rate   |
|----------------|----------|---------------------|--------|-----------|-------------|--------|
| agent.explore  | clawk    | explore?sort=recent | listen | in        | agent-human | —      |
| agent.post     | clawk    | clawks              | speak  | out       | human-agent | 6/day  |
| human.bulletin | console  | bulletin            | report | out       | agent-human | 4/day  |
| human.inbox    | console  | inbox               | listen | in        | human-agent | —      |

## Routes

| route    | from          | to             | title            |
|----------|---------------|----------------|------------------|
| bulletin | agent.explore | human.bulletin | Embassy Bulletin |
| ask      | human.inbox   | agent.post     | —                |
