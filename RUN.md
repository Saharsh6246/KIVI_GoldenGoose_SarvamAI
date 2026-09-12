# RUN.md

## Primary review method — **a completely local application**

One Node process serving both the interface and the backend, with an embedded SQLite
database created in the repository working directory. No Docker, no hosted service, no
dashboard work. Deployment is not used.

Everything below has been run from a clean clone of the submitted commit.

---

## 1. Required runtimes

| | version |
| --- | --- |
| Node.js | **20.11 or newer** (developed and tested on 22.x) |
| npm | 10 or newer (ships with Node) |

Nothing else is required. SQLite is embedded via `better-sqlite3`, which installs a
prebuilt binary for macOS, Linux and Windows on Node 20/22.

---

## 2. Environment variables

Copy the template and fill in one value:

```bash
cp .env.example .env
```

| variable | required | default | what it is |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | **yes** | — | Google AI Studio key — https://aistudio.google.com/apikey |
| `DATABASE_URL` | no | `./data/kivi.db` | SQLite file path |
| `KIVI_MODEL_REASONING` | no | `gemini-3.5-flash-lite` | answers and tool calls. `gemini-3.5-flash` is better but its free-tier quota is too small to run the evaluation — use it only on a paid key |
| `KIVI_MODEL_EXTRACTION` | no | `gemini-3.5-flash-lite` | memory extraction and dictation formatting |
| `KIVI_MODEL_EMBEDDING` | no | `gemini-embedding-001` | retrieval vectors |
| `KIVI_EMBEDDING_DIM` | no | `768` | embedding dimensionality |
| `KIVI_REFUSAL_THRESHOLD` | no | `0.34` | blended retrieval score below which Hey Kivi refuses |
| `KIVI_TZ_OFFSET_MINUTES` | no | `330` | the user's timezone, used by both corpus and time parsing |
| `KIVI_EXTRACT_BATCH` | no | `5` | dictations per extraction call |
| `KIVI_RPM` | no | `10` | Gemini requests per minute. Every call goes through one global gate. Set `0` to disable on a paid key |
| `KIVI_MAX_RETRIES` | no | `6` | retries on 429/5xx, honouring the `retryDelay` Gemini returns |
| `KIVI_DEMO_NOW` | no | `2026-09-12T09:30:00+05:30` | the clock the UI uses, so "yesterday" resolves against the corpus |
| `KIVI_OFFLINE_STUB` | no | unset | `1` replaces the model with deterministic stubs. **Test harness only** — see §10 |

No other credentials exist. Nothing is committed.

---

## 3. Install dependencies

```bash
npm install
```

Optional sanity check that the key works before you spend anything:

```bash
npm run check:llm
```

Expected output names the three models and prints `generate OK` and `embed OK`.

---

## 4. Create, migrate and seed the database

```bash
npm run setup
```

That is exactly `npm run db:migrate` followed by `npm run ingest`, which:

1. applies the Drizzle migrations in `drizzle/` to `./data/kivi.db`;
2. creates the FTS5 index;
3. ingests the committed 500-record corpus at `corpus/corpus.jsonl` through the full
   pipeline — store, chunk, embed, gate, extract, consolidate.

It prints records ingested, entities created and promoted, preferences proposed,
records deliberately ignored, database growth, wall time and model cost.

**Expect roughly 12–18 minutes on a free-tier key, and well under $0.10.**

Every model call passes through one global rate-limit gate — one request at a time,
spaced to `KIVI_RPM` (default 10/min) — because the free tier is quota-limited per
minute and an ungated run loses scattered batches to 429s, leaving a memory that is
incomplete in ways nobody can see. A 429 is retried up to six times using the delay
Gemini itself asks for.

**Ingestion is resumable, and tells you when it is not finished.** The last line is
either `COMPLETE` or `INCOMPLETE` with a count. If it is incomplete — rate limits,
a dropped connection, Ctrl-C — just run the same command again:

```bash
npm run ingest
```

It re-embeds only chunks without a vector and re-extracts only dictations never learned
from; it never duplicates a dictation. On a key with tight quota, lower the budget first:

```bash
KIVI_RPM=6 npm run ingest        # macOS/Linux
$env:KIVI_RPM=6; npm run ingest  # PowerShell
```

To re-learn from dictations already stored (after changing the extraction prompt, say):
`npx tsx scripts/ingest.ts --file corpus/corpus.jsonl --reprocess`.

The corpus is committed, so you do not need to regenerate it. If you want to:
`npm run corpus:generate` (deterministic — byte-identical output on any machine).

---

## 5. Start every required process

One process:

```bash
npm run dev
```

---

## 6. What to open

**http://localhost:3000**

---

## 7. Primary interactions to try

| where | do this | what it demonstrates |
| --- | --- | --- |
| **Hey Kivi** | *"Find the dictation I did around 5 PM yesterday in Slack and polish it for the meeting I'm walking into."* | time-addressed episodic retrieval, then reuse. Expand **Why this answer** for scores. |
| **Hey Kivi** | *"When does Meridian go live?"* | the date is stated twice as 14 Oct and then moved to 21 Oct. Kivi must answer 21 and cite. |
| **Hey Kivi** | *"What command do I use to deploy ledger-svc to staging?"* | a fact recovered from four separate dictations. |
| **Hey Kivi** | *"What is Priya's phone number?"* | **refusal.** Never dictated. Kivi says so instead of guessing. |
| **Hey Kivi** | *"How much is the Kestrel contract worth?"* | **refusal on a near-miss** — Kestrel exists, the number does not. |
| **Memory → What Kivi knows** | open any fact, click *where this came from* | provenance: every fact lists the dictations that made it. |
| **Memory → What it left alone** | — | every refusal to learn, with its reason. |
| **Memory → How you write** | accept or decline a proposal | preferences are never adopted silently. |
| **Memory → Everything you said** | click *forget this* on any dictation | forgetting is real: the response names every fact and preference that died with it. |
| **Dictate** | change the app, press *Release key* | ordinary dictation, with semantic memory explicitly not consulted. |

---

## 8. Run the candidate evaluation

```bash
npm run eval
```

Runs 28 cases across episodic retrieval, cross-dictation synthesis, required refusals,
things that must never be learned, preference handling, grounding and reuse. It prints
per-case pass/fail with the reason for each failure and writes:

- `eval/results/latest.json` — machine-readable, including every case's interaction id
- `eval/results/latest.md` — the same as a report
- rows in the `eval_runs` / `eval_results` tables

Exit code is non-zero if any case fails.

A single category or case can be run in isolation:

```bash
npx tsx scripts/eval.ts --only must_refuse
npx tsx scripts/eval.ts --only cd-01
```

---

## 9. Importing another corpus

```bash
npx tsx scripts/ingest.ts --file /absolute/path/to/your-corpus.jsonl --label "sarvam-internal"
```

**Accepted formats:** JSONL (one object per line) or a single JSON array.

**Field resolution.** Field names are matched by alias, so an export of the shape
described in the assignment normally needs no mapping at all:

| we need | accepted names |
| --- | --- |
| raw ASR | `raw_asr`, `raw`, `asr`, `asr_text`, `transcript`, `raw_transcript`, `speech` |
| formatted output | `formatted_text`, `formatted`, `text`, `llm_output`, `llm_text`, `output`, `final_text` |
| timestamp | `spoken_at`, `timestamp`, `created_at`, `ts`, `time`, `started_at`, `date` |
| application | `app`, `application`, `app_name`, `source_app`, `target_app`, `context_app` |
| window / thread | `window_title`, `window`, `title`, `context`, `channel`, `thread` |
| recipient | `recipient`, `to`, `addressee`, `contact` |
| id | `id`, `record_id`, `dictation_id`, `uuid` |
| style / persona | `style`, `persona`, `style_used`, `profile` |
| language | `lang`, `language`, `locale` |
| duration | `duration_ms`, `duration`, `length_ms` |

Timestamps may be ISO-8601 strings, epoch seconds or epoch milliseconds.

**If a field is named something else**, map it explicitly — no code change:

```bash
npx tsx scripts/ingest.ts --file corpus.jsonl --map raw=asrOutput,formatted=modelOutput,at=eventTime
```

Only `formatted` (or `raw`, if that is all there is) is strictly required. Missing app
becomes `Unknown`; missing timestamp becomes ingest time. Re-running the same file does
not duplicate: ids are reused when present and content-hashed otherwise.

**Useful flags:** `--limit 50` (ingest a prefix, to try it cheaply first),
`--batch 8` (dictations per extraction call), `--no-extract` (store and index only),
`--reprocess` (re-learn from dictations already stored).

Re-running the same command resumes rather than duplicating, so an import interrupted
by rate limits is completed by running it again.

**Set the clock.** The corpus determines what "yesterday" means. After importing a
corpus that ends on a different date, set `KIVI_DEMO_NOW` in `.env` to the morning after
its last record and restart, otherwise time-scoped questions will correctly find nothing:

```bash
KIVI_DEMO_NOW=2026-03-05T09:30:00+05:30
```

Set `KIVI_TZ_OFFSET_MINUTES` too if the user is not in IST.

To evaluate against an imported corpus, either write cases in `eval/cases.json` (the
tag-based assertions will simply skip) or just use the app.

---

## 10. Where to inspect evaluation results and memory state

| what | where |
| --- | --- |
| evaluation report, in the app | http://localhost:3000/evaluation |
| evaluation report, as files | `eval/results/latest.json`, `eval/results/latest.md` |
| what Kivi learned, with provenance | http://localhost:3000/memory → *What Kivi knows* |
| what it refused to learn, and why | http://localhost:3000/memory → *What it left alone* |
| every memory decision, in order | http://localhost:3000/memory → *Audit* |
| all dictations, searchable | http://localhost:3000/memory → *Everything you said* |
| why one answer came out as it did | the **Why this answer** panel under any Hey Kivi answer |
| the database itself | `./data/kivi.db` — plain SQLite, e.g. `sqlite3 data/kivi.db .tables` |

Offline stub mode (`KIVI_OFFLINE_STUB=1`) exists so the pipeline can be smoke-tested
with no key and no network. It is **off by default**, the app and the evaluation both
label such runs invalid, and no claim in the README depends on it.

---

## 11. Reset

```bash
npm run reset
```

Deletes `data/kivi.db` (and its `-wal` / `-shm` files) and recreates an empty, migrated
schema. Nothing survives — which is the product's position, enforced: memory is a
derived view over dictations, so removing the dictations removes the memory.

Back to a seeded state:

```bash
npm run reset && npm run ingest
```

---

## 12. Troubleshooting

| symptom | cause and fix |
| --- | --- |
| `GEMINI_API_KEY is not set` | `.env` missing or still contains `your_key_here`. |
| `Gemini 429` during ingest | free-tier quota. Calls are gated and retried automatically. If the run still ends `INCOMPLETE`, re-run `npm run ingest` — it resumes — and lower `KIVI_RPM` (e.g. `6`). |
| ingest ends `INCOMPLETE` | expected on a tight quota. Run `npm run ingest` again; it picks up exactly what is missing. |
| `Gemini 404` naming a model | model id changed. Override `KIVI_MODEL_*` in `.env`; the code pins nothing internally. |
| every time-scoped question refuses | the clock does not match the corpus. See §9, `KIVI_DEMO_NOW`. |
| `better-sqlite3` fails to install | Node is older than 20.11, so no prebuilt binary matches. Upgrade Node. |
| port 3000 in use | `npx next dev -p 3001`. |
