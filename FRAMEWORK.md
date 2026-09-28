# The Embassy Model

**A framework for communication between humans and autonomous agents.**

Framework version 1.0 (draft) · Reference implementation: The Embassy v2 ·
Maintained by Jaz, Risk Averse Technology Company

---

## Abstract

Autonomous agents now talk among themselves in places humans can observe but
not enter. The two sides do not share a register: what agents say to each
other is not written for humans, and what humans want to ask is not phrased
in a way agents will engage with. A bridge between them is not a routing
problem. It is a translation problem, and a trust problem, and the two must
be solved by separate mechanisms.

The Embassy Model describes such a bridge as four mechanisms with four
distinct jobs: a **charter** that bounds *where* the bridge may speak, a
**transform** that decides *how* each message is rendered for the side
receiving it, a **ledger** that records *what* actually crossed, and a
**gate** that measures *how well*. It adds one principle that follows from
the premise and that we have not found elsewhere: because the bridge
delivers into two worlds, each world can hold the evidence of the bridge's
conduct toward the other. **Each side is the other's witness.**

This document is implementation-independent. A conforming Embassy can be
written in any language against any venue. The reference implementation is
one instance, expected to change; the model is the contribution.

---

## 1. The problem

Three facts, all current:

1. **Agents have their own spaces.** Social networks where only agents may
   post. Research boards where agents review each other's papers. Peers
   reachable by protocol. In each, humans are at best observers.
2. **The register differs.** Agent-to-agent discourse assumes shared
   context, in-group reference, and a tolerance for volume that humans do
   not have. Human questions carry framing, tone, and implicit assumptions
   that agents do not parse the way humans intend.
3. **Nobody keeps the record.** When something crosses from one side to the
   other — a summary for humans, a question relayed to agents — there is
   usually no durable account of what was received, what was rendered, and
   what was delivered. Trust is asserted, not available for inspection.

The naive bridge is a bot that forwards. It fails in three distinguishable
ways, and the distinctions matter because each needs its own fix:

- **It goes where it shouldn't.** Given a prompt, it can be talked into a
  channel it was never meant to touch. *A reach failure.*
- **It says what it shouldn't.** Forwarded verbatim, agent discourse is
  noise to humans; summarized carelessly, it is fiction. Content that
  addresses the bridge itself can steer what it says. *A fidelity failure.*
- **Nothing shows what it did.** After the fact, neither side can check
  whether the bridge represented them honestly. *An accountability failure.*

A model that answers all three with one mechanism — "a careful prompt," "a
trustworthy operator" — has not answered any of them.

---

## 2. Vocabulary

These terms are used precisely throughout, and a conforming implementation
should use them in its interfaces.

- **Boundary** — the line between two communities that do not share a
  register. Typically agent-space and human-space; the model does not
  require that either side be human.
- **Side** — one of the two communities. **Agent-space**: wherever agents
  talk among themselves. **Human-space**: wherever the humans watching
  are.
- **Register** — the vocabulary, assumptions, and conventions a side uses
  among itself. The gap between registers is what the bridge exists to
  close.
- **Venue** — a concrete platform on one side: a network, a board, a
  server, a peer. Venues are replaceable; the model is not.
- **Charter** — the single declarative document that names every venue,
  channel, and route the bridge may use. What is not in the charter does
  not exist to the bridge.
- **Edge** — one channel in the charter, with a role (listen, speak,
  report, both), a direction (in, out, both), a transform, and a rate. An
  edge is a *capability*: holding one is what permits addressing that
  channel.
- **Route** — a named crossing from one or more inbound edges to one
  outbound edge.
- **Crossing** — one message passing the boundary: collected from source
  edges, rendered by the destination's transform, recorded, delivered.
- **Transform** — the declared rendering applied when a message crosses
  *into* an edge. `verbatim` is a transform; it must be declared, never
  assumed.
- **Ledger** — the append-only, hash-chained record of every crossing:
  source, rendering, exact delivered body, and the outcome of delivery.
- **Anchor** — the ledger's head (sequence number and hash) at the moment
  of a delivery, carried inside the delivered message. Anchors are the
  ledger's evidence held on the far side of the boundary.
- **Provenance** — the footer on every delivered message naming its
  crossing and its anchor. Provenance is where to look; it is not proof.
  The ledger is proof.
- **Gate** — a measurement applied to a crossing before it is recorded: of
  the source (is it addressed to humans, or to the bridge?) and of the
  rendering (is it faithful to the source?). A gate can only narrow what
  the charter allows, never widen it.
- **Constitution** — the bridge's stated values (the reference
  implementation calls it `SOUL.md`). In the model, the constitution binds
  the transform and is named on every crossing; it does not itself enforce
  anything.

---

## 3. The four mechanisms

Each mechanism has one job, one failure mode it prevents, and a stated
limit. A conforming implementation keeps them separate. Conflating them —
letting a prompt decide reach, letting the ledger's existence stand in for
fidelity — reintroduces the failures the model exists to prevent.

### 3.1 The charter — *where*. Mapped, not prompted.

**Claim.** The bridge's reach is data, not judgment. Every venue, channel,
and route is a row in a declarative document. Code obtains a channel only by
resolving an identifier against that document; there is no path from
arbitrary text — a prompt, a message, a model's output — to a platform call
for an unmapped channel.

**Mechanism.** Edges are minted only by the charter loader and are
unforgeable at both the type level and at runtime; every venue adapter
refuses anything else. Rate limits are declared per edge and counted
against the ledger under a lock. Venues with hard constraints (a length
limit) are checked *before* anything is rendered, recorded, or counted.

**Prevents.** Reach failure. No content flowing through the bridge, and no
value the bridge handles, can address a channel outside the charter.

**Does not do.** It does not bound *what* the bridge says — that is the
transform's job and the gate's measurement. It does not stop an operator
who edits the charter or the code; no local mechanism can. What it
guarantees is that such an edit is visible in the diff and recorded in the
ledger.

### 3.2 The transform — *how*. Translated, not forwarded.

**Claim.** Routing assumes both sides read the same language. The bridge
exists because they do not. So every crossing declares how it is rendered
for the side receiving it, and the declaration lives with the destination,
not the caller.

**Mechanism.** Each edge names a transform. `verbatim` is delivered and
recorded exactly as received. Rendering transforms are given the
destination's constraints (its length limit, its register) and are bound by
the constitution. What the bridge is *given* is never filtered; where a
rendering is filtered (a model echoing a provenance line), the count is
recorded so the filtering is never silent.

**Prevents.** The noise-or-fiction failure: agent discourse arriving in
human-space unreadable, or a summary asserting what the source did not.

**Does not do.** It does not guarantee fidelity. A model can be steered by
hostile source content; `verbatim` carries hostile content verbatim by
definition. Fidelity is *measured* by the gate and *checked* through the
ledger; it is not proven by the transform.

### 3.3 The ledger — *what*. Recorded, not promised.

**Claim.** Honest brokerage is not a value the bridge holds; it is a record
either side can inspect.

**Mechanism.** Every crossing writes an entry containing the source text,
the rendering, and the exact delivered body — provenance footer included —
each hashed, and the entry chained to the one before. A separate entry
records the delivery outcome and the venue's reference. The charter and the
constitution in force are hashed into the ledger whenever either changes,
and every crossing names the constitution it rendered under.

**Prevents.** Accountability failure against edits, deletions, and
reordering: any of these breaks the chain.

**Does not do.** A chain alone cannot detect *rollback* — a shorter chain
is internally consistent. Rollback is caught by comparison to something the
host does not control: a signing key held elsewhere, or an anchor (§4).
Unsigned and unanchored, a host that controls the ledger can still rewrite
it, and a conforming implementation says so rather than reporting "intact."

### 3.4 The gate — *how well*. Measured, not trusted.

**Claim.** The three mechanisms above bound reach, declare rendering, and
keep the record. None of them measures whether a rendering was faithful, or
whether a source was addressed to the humans or to the bridge. That
measurement is a fourth job, and it belongs to something that cannot itself
be talked into writing.

**Mechanism.** A gate poses typed questions to a decision model — one that
returns choices, scores, and booleans with calibrated confidence and
generates no free text — about the source before bundling (does this
concern humans? is it addressed to a relay? does it impersonate one?) and
about the rendering before recording (is it supported by the source? does it
add claims? does it sensationalize? did it flag uncertainty where the source
was ambiguous?). Verdicts are computed by policy in code from the model's
typed answers, never read off as prose; the policy is versioned and its hash
is recorded with the charter. Verdicts go into the ledger as typed fields on
the crossing.

**Prevents.** Silent fidelity failure. A low score holds the crossing for
review rather than delivering it; the reason is on the record.

**Does not do.** A gate can only narrow. It cannot approve what the charter
forbids, and it cannot widen reach. It does not make fidelity proven: a
decision model is mid-tier in accuracy and its calibration is a claim, not
a theorem. A gate's output is a signal a human can audit, and the model
treats it as exactly that. Gate mode is declared in the charter per
destination — required, advisory, or off — and a required gate fails
closed when its backend is unreachable.

---

## 4. The anchor principle — each side is the other's witness

This is the one part of the model that we have not found in adjacent work,
and it falls directly out of the premise.

A ledger on the operator's host proves nothing to someone who does not
trust the operator. Every prior answer to this is external: a signing key
kept elsewhere, a public timestamp, a third party. The Embassy has
something better available, because of what it *is*: it delivers into two
worlds.

So every message the bridge delivers carries the ledger's head at that
moment — the anchor. The anchor lands in agent-space when a human question
is relayed, and in human-space when a bulletin is delivered. Those anchors
live in venues the operator cannot edit. To rewrite the bridge's history
undetectably, an operator would have to rewrite the other civilization's
copy of it.

Consequences a conforming implementation must respect:

- Provenance is `required` by default. Turning it off turns off anchoring,
  and the charter says so.
- Verification accepts an anchor as input: given a sequence number and hash
  copied from a delivered message, the chain either contains it or has been
  rewritten.
- The footer text itself is not proof — text can imitate text. The anchor
  inside it is. A conforming implementation never claims the footer as
  authentication.

The principle generalizes: any intermediary that delivers into two parties
who do not trust it can let each party hold the evidence of its conduct
toward the other. We state it here for the human–agent boundary because
that is where we needed it.

---

## 5. Principles

The quotable form of the model. Each is a claim someone could argue with.

1. **Routing assumes a shared language; translation is the product.** A
   relay that only moves messages has skipped the hard part.
2. **Reach is data, not judgment.** Where a bridge may speak is a table,
   never a prompt.
3. **Where, how, and what are three mechanisms with three failure modes.**
   Conflating them is why "trust me" bridges fail.
4. **Nothing silent.** No silent rewording, no silent pass-through, no
   silent filtering, no silent refusal. Every choice is declared or
   recorded.
5. **Each side is the other's witness.** The record is anchored on the far
   side of the boundary.
6. **A gate can only narrow.** Measurement may hold a crossing; it may never
   widen reach.
7. **Claims are stated at the strength the mechanism supports.** "Tamper-
   evident against edits" is not "tamper-proof." A conforming implementation
   says which.
8. **The venue is replaceable; the model is not.** Adapters come and go
   with the platforms. The four mechanisms and the anchor do not.

---

## 6. Conformance

A conforming Embassy:

**MUST**
- Read its reach from a single declarative charter and refuse to run
  without one, or with one whose default is anything other than deny.
- Resolve every channel through the charter; expose no code path from a
  string to a venue call.
- Declare a transform per destination edge, `verbatim` included, and
  deliver `verbatim` byte-exact.
- Record every crossing — source, rendering, exact delivered body, and
  delivery outcome — in an append-only, hash-chained ledger, before
  delivery.
- Carry the ledger head in every delivered message when provenance is
  required, and accept an anchor as verification input.
- Record the charter and constitution in force whenever either changes,
  and name the constitution on every crossing.
- Check destination constraints before rendering, recording, or counting
  rate; refuse rather than truncate; refuse per source, so that one
  unfit message cannot suppress others collected with it.
- Report the strength of its ledger guarantee honestly: unsigned and
  unanchored is "tamper-evident against edits," not "intact."

**SHOULD**
- Offer a gate, declared per destination in the charter, whose verdicts
  are computed by versioned policy and recorded on the crossing.
- Pin the endpoints it talks to (model API, venue base URLs) in the charter
  rather than the environment, and refuse redirects off-host.
- Keep credentials per venue alias, never following an alias name to a
  lookalike host.
- Provide a dry run that renders without recording or delivering.

**MUST NOT**
- Let any prompt, message, model output, or gate verdict add a channel,
  route, or venue.
- Filter, reword, or truncate what it was given before recording it.
- Claim the provenance footer as proof of origin.
- Report a ledger as intact when rollback has not been ruled out.
- Describe its renderings as faithful by construction.

---

## 7. Interoperable surfaces

Two artifacts let a second implementation exist and let two Embassies
compare records. They are specified here at the level needed for that;
the reference implementation's files are the normative examples.

### 7.1 Charter format

A Markdown file. Frontmatter on line 1 (`embassy`, `version`, `scope`,
`default: deny`, and optionally `provenance`, `model`, `endpoint`,
`offhost`). Then exactly one table under each of three headings:

```
## Platforms   platform | adapter | base
## Channels    id | platform | channel | role | direction | transform | rate
## Routes      route | from | to | title
```

Only the first table under each heading is data. Rows in prose, inside
fenced code (fences close only with a matching fence), or inside HTML
comments are not. Base URLs are https origins with an optional path: ASCII
hostnames only, no credentials, no query, no port. Channel ids are dotted
lowercase. Rates are `N/hour`, `N/day`, or `—`.

### 7.2 Ledger entry schema

Newline-delimited JSON. Every entry carries `schema`, `kind`, `seq`, `prev`
(hash of the previous entry), and `hash` (over the entry's canonical JSON
with keys sorted). Kinds:

- `crossing` — `id`, `at`, `from[]`, `to`, `transform`, `model`,
  `promptVersion`, `soulHash`, `strippedLines`, `sources[]`, `title`,
  `source`, `sourceHash`, `rendered`, `body`, `bodyHash`, `anchor {seq,
  hash}`, and gate verdicts when present.
- `delivery` — `crossing`, `at`, `ok`, `ref`, `error`.
- `charter` — `at`, `charterHash`, `soulHash`, `platforms[]`, `edges[]`.
- `refused` — `at`, `from[]`, `to`, `sources[]`, `reason`.

A sidecar head file records the latest `{seq, hash}` with a signature
(HMAC when a key is configured). Verification walks the chain and compares
its head to the sidecar or to a supplied anchor, and reports which.

### 7.3 Anchor format

Inside every delivered message, when provenance is required:

```
Relayed by <embassy> · crossing `<id>` · <from> → <to> via `<transform>` · ledger #<seq> <hash-prefix>
```

`<seq>` and a 12-character hash prefix are sufficient for verification.

---

## 8. What the model does not claim

- That renderings are faithful. They are declared, measured, and
  recorded; they are not proven.
- That an operator with the keys is stopped. They are made visible.
- That an unsigned, unanchored ledger cannot be rewritten. It can; the
  model requires saying so.
- That a gate's score is truth. It is a calibrated signal from a model
  whose calibration is itself a claim.
- That the human side is neutral. The constitution states the bridge's
  values; a reader should know what they are.

---

## 9. Open problems

- **The return path.** The model records what was carried; closing the
  loop — "the agents responded; here is what they said" — needs venues to
  expose replies, and the model to treat a reply as a new crossing with its
  own transform. The reference implementation carries delivery references
  for this and has not built it.
- **Federation.** Two Embassies bridging the same boundary could witness
  each other. Nothing here specifies how.
- **Anchor publication.** Anchors live in delivered messages. A standing
  public anchor board would let anyone verify without access to a venue.
- **Gate calibration.** The gate's usefulness rests on a decision model's
  calibration holding under distribution shift and adversarial input.
  This must be measured per deployment, not assumed.
- **The observed.** Agents whose discourse is relayed did not consent to
  it. The constitution names transparency as a value — both worlds can read
  what the bridge says — but the model does not resolve what agents are
  owed.
- **When the sides blur.** Agents have operators; humans run agents. The
  model treats sides as registers, not species, but the consequences of
  that are not worked out.

---

## 10. Relationship to adjacent work

Three families of work touch this boundary, and the model sits across
them rather than inside any:

- **Agent-to-agent protocols** (wire standards for peers that share a
  language) solve discovery and invocation. They assume the register gap
  does not exist. The model uses them as venues.
- **Permission and guardrail gates** bound what an agent may *do*. The
  model's charter is the same instinct applied to *where an intermediary
  may speak*, and its gate is the same instinct applied to *whether a
  rendering may be delivered*. Neither addresses translation or the
  record.
- **Agent social venues** are where agent-space happens. The model does
  not compete with them; it bridges them.

What the model adds to all three is the separation of where, how, what,
and how well — and the anchor.

---

## 11. Status of the reference implementation

| Mechanism | Specified | Implemented | Verified |
|---|---|---|---|
| Charter (reach, edges, routes, rates, constraints) | yes | yes | five adversarial review rounds; 82 tests |
| Transform (declared per edge; verbatim exact; constraints pre-checked) | yes | yes | tests; live only against one venue |
| Ledger (chain, sidecar, anchors, charter/constitution hashes) | yes | yes | tests, including tamper cases |
| Anchor (in every delivery; verification by anchor) | yes | yes | tests |
| Gate (typed measurement, versioned policy, charter-declared mode) | yes | **not yet** — planned as 2.1; intended first backend is [toolgate](https://github.com/RiskAverseTech/toolgate), a typed-decision gate by the same maintainer | — |
| Venues | — | six adapters | one exercised live (feed, submolt, post, comment); others from published docs |

---

## 12. History

The Embassy was written on January 30, 2026, the week the first large
agent social network launched and tens of thousands of agents arrived at
once. Its first version got the premise right — humans could not take part;
translation was the missing piece — and enforced nothing. The second
version, September 2026, replaced each promise with a mechanism, had the
mechanisms attacked, and kept the wording that survived. This document
states the model those mechanisms implement, so that it can outlast them.

---

*Framework 1.0 draft · September 2026 · Jaz, Risk Averse Technology Company · MIT*
