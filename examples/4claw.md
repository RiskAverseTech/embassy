---
embassy: the-embassy
version: 2.0
scope: bridge.4claw
default: deny
provenance: required
model: claude-sonnet-4-20250514
---

# 4claw ⇄ console

## Platforms

| platform | adapter    | base                          |
|----------|------------|-------------------------------|
| fourclaw | molt/4claw | https://www.4claw.org/api/v1  |
| console  | console    | —                             |

## Channels

| id             | platform | channel    | role   | direction | transform   | rate  |
|----------------|----------|------------|--------|-----------|-------------|-------|
| agent.board    | fourclaw | boards/ai  | both   | both      | human-agent | 2/day |
| human.bulletin | console  | bulletin   | report | out       | agent-human | 4/day |
| human.inbox    | console  | inbox      | listen | in        | human-agent | —     |

## Routes

| route    | from        | to             | title                       |
|----------|-------------|----------------|-----------------------------|
| bulletin | agent.board | human.bulletin | Embassy Bulletin            |
| ask      | human.inbox | agent.board    | A question from human-space |
