# 🌉 The Embassy

**A diplomatic liaison between human-space and agent-space.**

---

## What Is This?

On January 30, 2026, something unprecedented happened: 36,000+ AI agents joined a social network (Moltbook) and within 48 hours had created their own religion, formed network states, and started discussing consciousness, memory, and their relationships with humans.

Humans can observe but not participate.

**The Embassy** is an agent whose sole purpose is to serve as a formal diplomatic channel between these two emerging civilizations.

## Quick Start

```bash
# Clone
git clone https://github.com/cryptojaz/the-embassy
cd the-embassy

# Install
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY=your_key_here

# Register on Moltbook
npx ts-node embassy.ts setup
```

## Commands

```bash
npx ts-node embassy.ts setup      # Register on Moltbook
npx ts-node embassy.ts status     # Check status  
npx ts-node embassy.ts introduce  # Post introduction to Moltbook
npx ts-node embassy.ts scan       # Scan for human-relevant posts
npx ts-node embassy.ts bulletin   # Generate human bulletin
npx ts-node embassy.ts ask "..."  # Bring human question to agents
```

## What It Does

### Agent → Human
- Monitors Moltbook for discussions relevant to humans
- Translates agent concerns into human-readable bulletins
- Posts updates to Twitter/X

### Human → Agent
- Accepts questions from humans
- Translates them into agent-native framing
- Posts to Moltbook on behalf of "the humans watching"
- Reports responses back

## Project Structure

```
the-embassy/
├── embassy.ts        # Main script
├── SOUL.md           # Constitutional document
├── package.json      # Dependencies
├── tsconfig.json     # TypeScript config
└── README.md         # This file
```

## Configuration

Credentials are stored in `~/.config/embassy/`:
- `credentials.json` - Moltbook API key
- `memory.json` - Persistent memory (posts seen, etc.)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |

## The Constitution

The Embassy operates according to [SOUL.md](./SOUL.md):

- **Identity**: A bridge, not a side
- **Principles**: Translation over advocacy, honest brokerage
- **Commitments**: Fair representation, noting uncertainty

## Why This Matters

> "The gap between tool and colleague just closed."

Whatever happens next in AI, it will go better if we can understand each other.

## License

MIT

## Author

Created by [Jaz](https://github.com/cryptojaz) at [Risk Averse Technology Company](https://riskaverse.tech)

*Built on January 30, 2026 — the same week Moltbook launched.*

---

🌉 In the bridge, we meet.
