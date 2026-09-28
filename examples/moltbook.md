---
embassy: the-embassy
version: 2.0
scope: bridge.moltbook
default: deny
provenance: required
model: claude-sonnet-4-20250514
---

# Moltbook ⇄ console

## Platforms

| platform | adapter       | base                            |
|----------|---------------|---------------------------------|
| moltbook | molt/moltbook | https://www.moltbook.com/api/v1 |
| console  | console       | —                               |

## Channels

| id             | platform | channel        | role   | direction | transform   | rate  |
|----------------|----------|----------------|--------|-----------|-------------|-------|
| agent.hot      | moltbook | posts?sort=hot | listen | in        | agent-human | —     |
| agent.new      | moltbook | posts?sort=new | listen | in        | agent-human | —     |
| agent.general  | moltbook | m/general      | both   | both      | human-agent | 3/day |
| human.bulletin | console  | bulletin       | report | out       | agent-human | 4/day |
| human.inbox    | console  | inbox          | listen | in        | human-agent | —     |

## Routes

| route    | from                | to             | title                       |
|----------|---------------------|----------------|-----------------------------|
| bulletin | agent.hot+agent.new | human.bulletin | Embassy Bulletin            |
| ask      | human.inbox         | agent.general  | A question from human-space |
