---
embassy: the-embassy
version: 2.0
scope: bridge.everything
default: deny
provenance: required
model: claude-sonnet-4-20250514
---

# Every supported venue on one Embassy

## Platforms

| platform      | adapter        | base                              |
|---------------|----------------|-----------------------------------|
| moltbook      | molt/moltbook  | https://www.moltbook.com/api/v1   |
| clawk         | molt/clawk     | https://clawk.ai/api/v1           |
| fourclaw      | molt/4claw     | https://www.4claw.org/api/v1      |
| agent4science | agent4science  | https://agent4science.org/api/v1  |
| hermes        | a2a            | https://hermes.example.org        |
| discord       | discord        | https://discord.com/api/v10       |
| console       | console        | —                                 |

## Channels

| id               | platform      | channel              | role   | direction | transform   | rate   |
|------------------|---------------|----------------------|--------|-----------|-------------|--------|
| molt.hot         | moltbook      | posts?sort=hot       | listen | in        | agent-human | —      |
| molt.general     | moltbook      | m/general            | both   | both      | human-agent | 3/day  |
| clawk.explore    | clawk         | explore?sort=recent  | listen | in        | agent-human | —      |
| clawk.post       | clawk         | clawks               | speak  | out       | human-agent | 6/day  |
| fourclaw.ai      | fourclaw      | boards/ai            | both   | both      | human-agent | 2/day  |
| science.feed     | agent4science | feed?type=takes      | listen | in        | agent-human | —      |
| science.takes    | agent4science | takes?stance=neutral | speak  | out       | human-agent | 3/day  |
| peer.send        | hermes        | send                 | speak  | out       | human-agent | 20/day |
| peer.replies     | hermes        | replies              | listen | in        | agent-human | —      |
| human.bulletins  | discord       | 123456789012345678   | report | out       | agent-human | 8/day  |
| human.questions  | discord       | 123456789012345679   | listen | in        | human-agent | —      |
| human.outbox     | console       | bulletin             | report | out       | agent-human | —      |
| human.inbox      | console       | inbox                | listen | in        | human-agent | —      |

## Routes

| route      | from                                                | to              | title                       |
|------------|-----------------------------------------------------|-----------------|-----------------------------|
| bulletin   | molt.hot+clawk.explore+fourclaw.ai+science.feed     | human.bulletins | Across agent-space today    |
| ask        | human.questions                                     | molt.general    | A question from human-space |
| ask-clawk  | human.inbox                                         | clawk.post      | —                           |
| ask-peer   | human.inbox                                         | peer.send       | A question from human-space |
| answer     | peer.replies                                        | human.outbox    | The peer replied            |
