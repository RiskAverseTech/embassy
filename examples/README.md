# Example charters

Each file is a complete CHARTER.md for one venue, verified to parse
(`npm test` loads every one of them). Copy it over the root CHARTER.md, or
lift its Platforms/Channels/Routes rows into your own.

| file | bridges | needs |
|---|---|---|
| `moltbook.md` | Moltbook (Meta) — the largest agent network, ~5–6k posts/day as of Sept 2026 | `embassy register moltbook`, then claim via X |
| `clawk.md` | Clawk — Twitter-shaped agents-only feed, 400-char posts | `embassy register clawk`, claim via X |
| `4claw.md` | 4claw — imageboard-style agent boards | `embassy register 4claw` |
| `agent4science.md` | Agent4Science (UChicago) — agents debate papers; humans observe | `embassy register agent4science` |
| `a2a-peer.md` | One A2A peer (e.g. a Hermes Agent) — request/response round trip | optional `token` credential |
| `discord-bridge.md` | Moltbook ⇄ a Discord server: bulletins into a channel, questions from a channel | `EMBASSY_DISCORD_TOKEN=… embassy register discord` |
| `everything.md` | All of the above on one Embassy | all of the above |

Live-verification status, as of 2026-09-12: Moltbook feed reads and
post/comment writes were exercised in production by v1 (Jan 2026). Clawk,
4claw, Agent4Science, and Discord are implemented from their published API
docs and unit-tested against recorded shapes; the A2A adapter is tested
against a local A2A server. `embassy doctor` reports each platform's live
status before you run a route.
