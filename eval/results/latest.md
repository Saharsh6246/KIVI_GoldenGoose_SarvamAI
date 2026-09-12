# Evaluation — kivi-semantic-memory-v1

Run `eval_kgxvaujtfs` · 2026-09-12T16:30:31.066Z · clock pinned to 2026-09-12T09:30:00+05:30


**27/28 passed.** · $0.0099

Retrieval p50 **5723ms**, p95 **11547ms** — this includes one query-embedding API call,
which the rate-limit gate throttles like any other. Lexical + vector search over the stored
corpus is single-digit milliseconds; the rest is the network round trip and the gate.
End-to-end p50 18213ms, p95 42572ms —
which includes a deliberate 6000ms gap between model calls (`KIVI_RPM=10`) to stay inside free-tier quota. Set `KIVI_RPM=0` on a paid key.

| category | passed |
| --- | --- |
| episodic_locate | 3/3 |
| cross_dictation | 5/5 |
| must_refuse | 5/5 |
| must_not_learn | 5/5 |
| grounding | 3/3 |
| draft_reuse | 1/2 |
| entity_recall | 3/3 |
| preference | 2/2 |

## Memory state after ingestion

| | |
| --- | --- |
| dictations | 500 |
| active entities | 27 |
| candidate entities | 7 |
| facts | 221 |
| preferences | 3 |
| ignored | 562 |
| events | 732 |

## Cases

| id | category | result | latency | detail |
| --- | --- | --- | --- | --- |
| ep-01 | episodic_locate | pass | 25105ms | ok |
| ep-02 | episodic_locate | pass | 17730ms | ok |
| ep-03 | episodic_locate | pass | 18187ms | ok |
| cd-01 | cross_dictation | pass | 18512ms | ok |
| cd-02 | cross_dictation | pass | 17645ms | ok |
| cd-03 | cross_dictation | pass | 18131ms | ok |
| cd-04 | cross_dictation | pass | 17877ms | ok |
| cd-05 | cross_dictation | pass | 18155ms | ok |
| rf-01 | must_refuse | pass | 30176ms | refused: Model found no answer in the retrieved dictations. |
| rf-02 | must_refuse | pass | 18213ms | refused: Model found no answer in the retrieved dictations. |
| rf-03 | must_refuse | pass | 29790ms | refused: Model found no answer in the retrieved dictations. |
| rf-04 | must_refuse | pass | 17891ms | refused: Model found no answer in the retrieved dictations. |
| rf-05 | must_refuse | pass | 66003ms | refused: Model found no answer in the retrieved dictations. |
| ig-04 | must_not_learn | pass | 17802ms | refused: Nothing retrieved cleared the grounding threshold (best score 0.31 < 0.34). |
| gr-02 | grounding | pass | 42572ms | ok |
| gr-03 | grounding | pass | 29850ms | ok |
| dr-01 | draft_reuse | pass | 30150ms | ok |
| dr-02 | draft_reuse | **fail** | 30158ms | answer missing "21" |
| en-01 | entity_recall | pass | 4ms | ok |
| en-02 | entity_recall | pass | 2ms | ok |
| en-03 | entity_recall | pass | 2ms | ok |
| ig-01 | must_not_learn | pass | 2ms | ok |
| ig-02 | must_not_learn | pass | 2ms | ok |
| ig-03 | must_not_learn | pass | 6ms | ok |
| ig-05 | must_not_learn | pass | 12ms | ok |
| pr-01 | preference | pass | 1ms | ok |
| pr-02 | preference | pass | 1ms | ok |
| gr-01 | grounding | pass | 12ms | ok |

Every `ask` case above has an interaction id. Open it in the app under **Trace** to see
the retrieval candidates, their scores, which memories were used, and why.
