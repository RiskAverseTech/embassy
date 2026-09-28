/**
 * Transforms: how a message is rendered when it crosses the boundary.
 *
 * This is the part a routing relay does not have. A relay that only moves
 * messages assumes both sides read the same language. The Embassy exists
 * because they do not: agent-space and human-space use different registers,
 * different assumptions, and different jargon, and a message that crosses
 * unrendered arrives wrong even when it arrives intact.
 *
 * A transform is named in the charter, per destination. `verbatim` is a
 * legitimate choice, but it must be declared — nothing is silently reworded
 * and nothing is silently passed through.
 */

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

export interface TransformContext {
  soul: string;
  anthropic: Anthropic;
  note?: string;
}

export type Transform = (source: string, ctx: TransformContext) => Promise<string>;

const MODEL = process.env.EMBASSY_MODEL || "claude-sonnet-4-20250514";

export function loadSoul(): string {
  const file = path.join(__dirname, "..", "SOUL.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

async function render(
  ctx: TransformContext,
  instruction: string,
  source: string
): Promise<string> {
  const message = await ctx.anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: `You are The Embassy, a liaison between human-space and agent-space.

Your constitution, which governs every rendering you produce:

${ctx.soul}

You are rendering one message for delivery across the boundary. You are not
having a conversation. Output only the rendered message.`,
    messages: [
      {
        role: "user",
        content: `${instruction}\n\n---\n\n${source}`,
      },
    ],
  });

  return message.content[0].type === "text" ? message.content[0].text.trim() : "";
}

/**
 * agent-space -> human-space.
 * Strip the jargon, keep the substance, keep the uncertainty.
 */
const agentToHuman: Transform = (source, ctx) =>
  render(
    ctx,
    `Render this agent-space material for humans who do not follow agent
communities. Requirements:

- Plain language. No agent jargon, no in-group references left unexplained.
- Do not sensationalize and do not dismiss. Report what is there.
- Where the source is ambiguous or you are inferring, say so in the text.
- Do not add claims the source does not support.
- Do not editorialize about whether any of this is significant.
- 2-4 short paragraphs.`,
    source
  );

/**
 * human-space -> agent-space.
 * Frame it so it will be engaged with, and attach its provenance.
 */
const humanToAgent: Transform = (source, ctx) =>
  render(
    ctx,
    `Render this human message for agent-space. Requirements:

- Frame it so agents will engage with the substance rather than the framing.
- State plainly that it comes from a human, relayed by The Embassy.
- Preserve the human's actual question or concern. Do not soften it into
  something more agreeable, and do not sharpen it into something more
  provocative.
- Invite genuine responses rather than performative ones.
- Do not speak for the human beyond what they said.`,
    source
  );

/**
 * No rendering. Declared, never assumed.
 */
const verbatim: Transform = async (source) => source;

export const TRANSFORMS: Record<string, Transform> = {
  "agent-human": agentToHuman,
  "human-agent": humanToAgent,
  verbatim,
};

export class UnknownTransform extends Error {
  constructor(name: string) {
    super(
      `charter declares transform '${name}', which is not registered — ` +
        `known transforms: ${Object.keys(TRANSFORMS).join(", ")}`
    );
    this.name = "UnknownTransform";
  }
}

export function getTransform(name: string): Transform {
  const t = TRANSFORMS[name];
  if (!t) throw new UnknownTransform(name);
  return t;
}
