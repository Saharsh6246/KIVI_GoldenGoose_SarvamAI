# Kivi — semantic memory

**Kivi remembers what you said, not who you are.**

This repository is a working answer to the Golden Goose assignment: a product position for
semantic memory in Kivi, and one end-to-end implementation of it.

- **[docs/positioning.md](docs/positioning.md)** — the positioning statement (100 words)
- **[docs/vision.md](docs/vision.md)** — the product vision (600 words)
- **[RUN.md](RUN.md)** — how to run, seed, evaluate, import a corpus and reset

---

## The product

Kivi sits over the whole machine. A person dictates into Slack, Mail, Linear, Cursor, Notes —
forty times a day — and every one of those goes out and vanishes. Kivi was the only thing
present for all of it.

So semantic memory here is **a searchable record of your own working voice**, not a model of
you. Kivi can find what you said, reuse it, and answer questions about it. It will not
conclude that you are stressed, or diabetic, or junior, and it will not act on such a belief.

Three rules carry that position into the code:

**1. Nothing is remembered that you did not say.** No screen capture, no always-on
microphone, no calendar scraping. Every memory traces to a dictation you can replay.

**2. Every answer cites, or admits it has none.** Refusal is a first-class output. "I don't
have that" is a correct answer and the evaluation tests for it in five separate cases.

**3. Forgetting is real.** Facts and preferences are *derived views* over dictations. Delete
a dictation and everything it taught disappears with it — the entity is demoted or removed,
the preference loses its evidence. This is a deliberate inversion of the industry norm, where
deleting a conversation leaves its conclusions behind.

And one boundary: **memory speaks only when spoken to.** Semantic memory never touches
ordinary dictation. Dictation is a motor act with no moment to explain itself, so a
memory-driven change there is indistinguishable from a mis-hearing — one wrong silent
substitution costs more trust than ten right ones earn. Only phonetic memory (spelling) and
Styles (which the user set deliberately) shape dictation. The `Dictate` screen says so on
screen, every time.

### What this position rules out

Deliberately, and these were all buildable: psychographic or sentiment profiles; proactive
suggestions; screen or ambient capture; inferring health, money, mood or relationships from
what was dictated; cross-user learning; and memory that silently alters dictation.

---

## Use cases it was built around

Three, chosen because they are the ones worth having. The toolset is exactly what they need
and nothing more.

1. **Find and reuse.** *"Find the dictation I did around 5 PM yesterday in Slack and polish it
   for the meeting I'm walking into."* A time address resolves to an episode; the episode is
   rewritten under preferences the person accepted.
2. **Answer from my own record.** *"When does Meridian go live?"* — stated twice as 14 October
   and then moved to 21 October across three dictations in two apps. The answer must be 21,
   cited, with the revision understood.
3. **What do I know about X.** *"Who owns Tollgate now?"* — a fact promoted only because two
   independent dictations established it, served with its provenance.

---

## Architecture

```
                         ┌──────────────────────────────────────────┐
  dictation ────────────▶│  dictations        the source of truth   │
  (live, or imported)    │  dictation_chunks  FTS5 + vectors        │
                         └───────────────┬──────────────────────────┘
                                         │  derived, provenance-linked,
                                         │  cascade-deleted
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
            entities + facts      preferences          ignored_records
            entity_mentions       preference_evidence  (what it refused
            (provenance)          (behavioural)         to learn, and why)
                    │                    │                    │
                    └────────────────────┴────────────────────┘
                                         │
                                    memory_events   (append-only audit)
                                         │
      Hey Kivi ──▶ tools ──▶ retrieval ──┴──▶ answer ──▶ grounding guard
                                                            │
                                             interactions + interaction_citations
```

**Stack.** Next.js 15 (App Router, one process for UI and API) · SQLite via better-sqlite3 ·
Drizzle ORM with real migrations · Gemini over plain `fetch` (no SDK, deliberately: the
reviewing agent runs this literally and a pinned SDK is one more thing that can break).

One consequence of going SDK-free worth naming: Gemini 3.x signs each `functionCall` part
with a `thoughtSignature` that must be replayed verbatim on the following turn. The tool
loop therefore stores the model's own response parts and sends them back unmodified rather
than reconstructing a turn from name and arguments.

### Ingestion — five stages, every refusal logged

| stage | what it does | what it records |
| --- | --- | --- |
| 1 store | the dictation verbatim, raw ASR and formatted output | `dictations` |
| 2 index | chunk + embed (`gemini-embedding-001`, 768-d), FTS5 rebuild | `dictation_chunks` |
| 3 gate | cheap deterministic check for anything durable | `ignored_records` with a reason |
| 4 extract | batched model call, strict JSON schema, span-supported | model usage, cost |
| 5 consolidate | promotion by repetition, provenance, supersession | `entities`, `entity_facts`, `preferences`, `memory_events` |

Ingestion is **gated and resumable**. Every model call passes a single rate-limit gate,
and each dictation is marked processed only after its consolidation commits — so a run
cut short by quota leaves a precise, recoverable gap rather than a silently incomplete
memory. Re-running `npm run ingest` embeds only unembedded chunks and extracts only
unlearned dictations. The run ends by telling you `COMPLETE` or `INCOMPLETE`, with counts.

**The evidence standard** lives in one file, `src/lib/memory/policy.ts`, so it can be read in
one sitting: a candidate is promoted to a fact only after **two distinct dictations**; a
preference is only *proposed* after **three** pieces of behavioural evidence, and is never
applied until the person accepts it; and the extraction prompt is forbidden from emitting any
claim about the person.

Extraction can only emit something supported by a span of the dictation it read. Consolidation
checks that independently and drops anything whose name does not appear in the source.

### Retrieval — three signals

**Lexical** (FTS5/BM25, weighted toward the formatted text) catches exact names, acronyms and
jargon that embeddings blur. **Vector** (cosine over chunk embeddings, brute-force — 500
records is small and honesty beats a needless index) catches paraphrase. **Structural**
filters — time window, app, recipient — come from the request itself.

One non-obvious decision: when a person says *"around 5pm yesterday in Slack"* they have given
an **address**, not a description. If that address resolves to a handful of dictations, the
address is the grounding, and text similarity is the wrong thing to be confident about. So a
narrow explicit filter raises the score floor, and ties are broken by **proximity to the named
time**, not recency — "around 5" should not return the 6:50 message first.

Time expressions are parsed deterministically rather than by the model, for the same reason:
a model that guesses a date range produces a confidently wrong answer, which is the exact
failure the position forbids. A window that finds nothing is widened up to a whole day before
Kivi gives up, so "you said it at 5:40, not 5:00" beats a false refusal.

### Hey Kivi — four tools and two guards

`search_dictations` · `get_dictation` · `lookup_entity` · `draft_from`. That is the whole
surface, because that is what the three use cases need.

Around the tool loop:

- **Grounding guard** — the answer is parsed for `[d_…]` citations and each is checked against
  what retrieval actually returned *in that turn*. Invented citations are stripped. An answer
  with no valid citation is not shipped as an answer; it becomes a refusal.
- **Threshold guard** — if nothing retrieved clears `KIVI_REFUSAL_THRESHOLD`, Kivi says it does
  not have it rather than composing something plausible out of near-misses.

### The inspection path

Every turn writes an `interactions` row and an `interaction_citations` row for **everything
retrieval surfaced, used or not**, with its lexical score, vector score, blended score and
whether the answer ended up citing it. That is what the *Why this answer* panel renders, and
it is how "why did memory *not* affect this result?" gets answered.

---

## The corpus

`corpus/corpus.jsonl` — 500 records, one persona, eight weeks, seven applications. Each record
carries raw ASR (disfluent, unpunctuated, with plausible mishearings: *meridien*, *toll gate*,
*kartik*), the formatted output, and the metadata a real dictation log carries.

It is generated **deterministically from a seeded template generator, not from a language
model**. Two reasons. It is byte-identical on any machine and in any timezone, so the
evaluation is reproducible. And because the facts are *planted*, the evaluation can assert
real ground truth — "this was stated across three dictations in two apps, and revised once;
did Kivi recover the revision?" — instead of grading vibes. `corpus/ground_truth.json`
records exactly what was planted, including material that must **not** be learned.

---

## Results

From `npm run eval` — 28 cases across eight categories. Running it writes `eval/results/latest.md` and `latest.json`; `/evaluation` renders the
report in the app.

Categories: episodic retrieval · cross-dictation synthesis · required refusals · things that
must never be learned · entity provenance · preference handling · grounding · reuse.

Notable assertions, because they test the position rather than the plumbing:

- every active entity is backed by **two or more distinct dictations** — the promotion rule,
  checked directly against the database
- **no orphan provenance**: every mention points at a dictation that exists
- the physiotherapy, compensation and colleague's-family dictations are **still searchable**
  but produced **no entity and no fact** — sensitive material is unlearned, not deleted
- **no preference is active** without the person having accepted it
- across the whole run, **every citation resolves** to a dictation retrieval actually returned
- five distinct refusal cases, including a near-miss (*"how much is the Kestrel contract
  worth?"* — Kestrel exists, the number never does)

Failures are printed by the runner, listed in the report, and shown on `/evaluation`. They
are not hidden.

### The one failing case, and why it is the right failure

**27 of 28 pass. `dr-02` fails:** *"Draft a mail to Sandra with the current Meridian date."*
Kivi answered **"I don't have the current Meridian date"** and refused to write the mail.

The date is in the corpus, and `cd-01` proves Kivi finds it — asked directly, it answers 21
October with citations. On this compositional request the search queries the model formed
missed the three dictations carrying the date, so retrieval came back without it.

What it did next is the point. Faced with a request to *draft a mail*, holding sixteen
retrieved dictations about Meridian and no date among them, it declined instead of writing a
confident, well-formatted, plausible mail with an invented date. That is the position holding
at the exact moment it is most expensive to hold it, and the failure mode it prevented — a
fluent business email containing a wrong commitment sent to a client — is far worse than a
refusal.

The honest fix is better retrieval for multi-step requests (query expansion, or letting
`draft_from` pull the facts it needs rather than depending on the answering turn to have found
them first). That is real work, and it is not done. The case is left failing rather than
loosened until it passes.

### One case was corrected, not the system

`ep-03` originally asserted that the 17:04 sign-off status was the last Slack dictation of the
day. It is not — a message at 18:53 is later, and Kivi answered with that one. The assertion
was wrong and the system was right, so the assertion was changed. The `expectation` field in
`eval/cases.json` records this.

---

## Limitations

Honest ones.

- **Compositional requests can under-retrieve.** See `dr-02` above: a request that needs a
  lookup *and* a rewrite can fail to surface the fact the rewrite needs. It refuses rather
  than inventing, but a refusal is still a failure to be useful.

- **Speech recognition is not implemented.** Transcripts are replayed through a client of our
  own design, as the assignment permits.
- **Entity resolution is conservative.** Alias matching is exact-after-normalisation plus
  whatever the extractor supplies. *MRD* only unifies with *Meridian* because a dictation says
  so. Embedding-based clustering would merge more, and would also merge wrongly, which is the
  worse error for this product.
- **Vector search is brute-force.** Fine at 500 records and honest about it; past ~50k chunks
  this needs sqlite-vec or similar.
- **Supersession is detected, not modelled.** Later dictations win when the answering model is
  told which is later; there is no temporal reasoner deciding that "moved to the 21st" retires
  "the 14th" as a stored fact.
- **The extractor is a single model call per batch.** No self-consistency, no second pass. It
  is conservative by prompt, and consolidation double-checks it, but recall is bounded by it.
- **One user.** No multi-tenancy, no auth. Out of scope for the demonstration.
- **Costs are reported, not optimised.** Batching and the rate-limit gate are the only
  controls; there is no caching of repeated extractions.
- **Ingest is single-threaded by design.** The rate-limit gate serialises model calls so
  a free-tier key completes rather than half-completes. On a paid key set `KIVI_RPM=0`.

---

## AI use

Disclosed plainly.

The **product position and vision** in `docs/` were developed by the candidate in conversation
with Claude, used as a research and challenge partner — competitive analysis of how ChatGPT
memory, Wispr Flow, Granola, Notion AI and Rewind treat memory and user control, and pressure
on the stance until it ruled things out. The position taken, and the argument for it, are the
candidate's; the drafting was collaborative.

The **implementation** was written with Claude as a pair, and reviewed, corrected and tested
by the candidate. Two design decisions came out of the build rather than the plan and are
worth naming: the structural score floor for time-addressed retrieval, and the deterministic
corpus with planted ground truth in place of an LLM-generated one.

The **corpus** contains no model-generated text at all — it is template-generated, for the
reasons above.

Gemini is used at runtime for three things: extraction, answering with tools, and embeddings.
No other model is called.
