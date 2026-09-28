/**
 * The wall is the load-bearing claim of v2, so it gets the tests.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Charter, ScopeViolation, CharterError } from "./charter";
import { Ledger } from "./ledger";
import { getTransform, TRANSFORMS, UnknownTransform } from "./transforms";

function charterFile(body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "embassy-")), "CHARTER.md");
  fs.writeFileSync(file, body);
  return file;
}

const VALID = `
---
embassy: test
version: 2.0
scope: test.scope
default: deny
provenance: required
---

| id        | platform | channel   | role   | direction | transform   | rate  |
|-----------|----------|-----------|--------|-----------|-------------|-------|
| in.only   | console  | a         | listen | in        | agent-human | —     |
| out.only  | console  | b         | speak  | out       | human-agent | 2/day |
| both.ways | console  | c         | both   | both      | verbatim    | —     |
`;

test("a mapped channel resolves", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.equal(charter.resolve("in.only").channel, "a");
  assert.equal(charter.list().length, 3);
});

test("an unmapped channel does not exist", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.throws(() => charter.resolve("m/general"), ScopeViolation);
  assert.throws(() => charter.resolve("out.only.admin"), ScopeViolation);
  assert.throws(() => charter.resolve(""), ScopeViolation);
});

test("a listen channel cannot be written to", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.throws(() => charter.assertWritable("in.only"), ScopeViolation);
  assert.doesNotThrow(() => charter.assertReadable("in.only"));
});

test("a speak channel cannot be read from", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.throws(() => charter.assertReadable("out.only"), ScopeViolation);
  assert.doesNotThrow(() => charter.assertWritable("out.only"));
});

test("a crossing must satisfy both ends", () => {
  const charter = Charter.load(charterFile(VALID));

  // legal: readable source, writable destination
  const ok = charter.assertCrossing("in.only", "out.only");
  assert.equal(ok.transform, "human-agent");

  // illegal in every other combination
  assert.throws(() => charter.assertCrossing("out.only", "in.only"), ScopeViolation);
  assert.throws(() => charter.assertCrossing("in.only", "in.only"), ScopeViolation);
  assert.throws(() => charter.assertCrossing("in.only", "nowhere"), ScopeViolation);
  assert.throws(() => charter.assertCrossing("nowhere", "out.only"), ScopeViolation);
});

test("the transform comes from the destination, not the caller", () => {
  const charter = Charter.load(charterFile(VALID));
  assert.equal(charter.assertCrossing("in.only", "both.ways").transform, "verbatim");
  assert.equal(charter.assertCrossing("in.only", "out.only").transform, "human-agent");
});

test("an Embassy that defaults to allow refuses to open", () => {
  const permissive = VALID.replace("default: deny", "default: allow");
  assert.throws(() => Charter.load(charterFile(permissive)), CharterError);
});

test("a malformed charter is refused rather than half-applied", () => {
  assert.throws(() => Charter.load(charterFile("no frontmatter here")), CharterError);

  const badRole = VALID.replace("| listen |", "| admin  |");
  assert.throws(() => Charter.load(charterFile(badRole)), CharterError);

  const badRate = VALID.replace("2/day", "loads");
  assert.throws(() => Charter.load(charterFile(badRate)), CharterError);

  const dupe = VALID + "| in.only | console | z | listen | in | verbatim | — |\n";
  assert.throws(() => Charter.load(charterFile(dupe)), CharterError);
});

test("an undeclared transform is refused", () => {
  assert.throws(() => getTransform("smuggle"), UnknownTransform);
  assert.ok(TRANSFORMS["verbatim"]);
});

test("verbatim passes through unchanged", async () => {
  const out = await TRANSFORMS["verbatim"]("exactly this", {} as any);
  assert.equal(out, "exactly this");
});

test("the ledger records both sides of a crossing and verifies", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "l.jsonl");
  const ledger = new Ledger(file);

  const c = ledger.record({
    from: "in.only",
    to: "out.only",
    transform: "human-agent",
    source: "what the human said",
    rendered: "what agent-space received",
  });

  const check = ledger.verify(c.id);
  assert.equal(check.ok, true);
  assert.equal(check.crossing!.source, "what the human said");
  assert.equal(check.crossing!.rendered, "what agent-space received");
  assert.equal(ledger.verify("nope").ok, false);
});

test("rate counting reads the ledger, so restarts do not reset it", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "l.jsonl");
  const entry = {
    from: "in.only",
    to: "out.only",
    transform: "verbatim",
    source: "s",
    rendered: "r",
  };

  const first = new Ledger(file);
  first.record(entry);
  first.record(entry);

  // a fresh process, same ledger on disk
  const second = new Ledger(file);
  assert.equal(second.countWithin("out.only", { count: 2, per: "day" }), 2);
  assert.equal(second.countWithin("in.only", { count: 2, per: "day" }), 0);
});

test("the shipped charter is valid", () => {
  const charter = Charter.load(path.join(__dirname, "..", "CHARTER.md"));
  assert.equal(charter.meta.default, "deny");
  for (const edge of charter.list()) {
    assert.ok(TRANSFORMS[edge.transform], `unregistered transform '${edge.transform}'`);
  }
});
