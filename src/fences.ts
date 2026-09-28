/**
 * CommonMark-style fence tracking, shared by the charter parser and the
 * Discord chunker. A fence opens with three or more backticks or tildes; it
 * closes only with the SAME character, at least as many of them, and
 * nothing else on the line. A backtick fence's info string may not contain
 * a backtick, so a line like ```a``` inline is not a fence at all.
 *
 * "Any fence closes any fence" was an injection vector (open with ```,
 * write ~~~, and everything after renders as code while a naive parser
 * thinks the block ended). This is the fix.
 */

export interface Fence { ch: "`" | "~"; len: number; info: string }

export function fenceLine(line: string): { open: Fence } | { close: true } | null {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  const ch = m[1][0] as "`" | "~";
  const info = m[2].trim();
  if (ch === "`" && info.includes("`")) return null;
  return { open: { ch, len: m[1].length, info } };
}

/** Advance fence state by one line. Returns the new state and whether this line was a fence marker. */
export function step(state: Fence | null, line: string): { state: Fence | null; marker: boolean } {
  const f = fenceLine(line);
  if (!state) return f ? { state: (f as { open: Fence }).open, marker: true } : { state: null, marker: false };
  // inside a fence: only a matching closer ends it
  const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  if (m && m[1][0] === state.ch && m[1].length >= state.len) return { state: null, marker: true };
  return { state, marker: false };
}

/** The lines of `text` that are NOT inside (or a marker of) a fenced block. */
export function stripFenced(text: string): string[] {
  const kept: string[] = [];
  let state: Fence | null = null;
  for (const line of text.split("\n")) {
    const r = step(state, line);
    state = r.state;
    if (!r.marker && !state) kept.push(line);
    else if (!r.marker && state) { /* inside a fence: dropped */ }
  }
  return kept;
}
