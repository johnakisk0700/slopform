# Campaign feedback topic analysis

Status: implemented backend slice, 2026-09-08.
Decision: [ADR 0018](../../decisions/0018-campaign-topic-analysis.md).

## Purpose and input scope

An explicit admin request groups **active extracted feedback notes** from one
campaign into topics. This is an immutable snapshot analysis. It does not claim
to cover all campaign feedback or refresh itself when more testimony arrives.

The initial input excludes dismissed notes, staff notes, deterministic fallback
notes, scored/directed answers, attention records and raw transcripts. Staff
notes can contain operator commentary; counting them as respondent testimony
would misrepresent support. The existing live extraction, STOP, profanity,
WhatsApp delivery, Assistant Mongo storage and campaign summary are unchanged.

Node owns selection, provider calls, transactions, cache, result validation and
counts. A short-lived Python process owns numerical clustering and BERTopic
keywords only; it receives no credentials, database connection or HTTP server.

## HTTP contract

All routes use the existing global Clerk admin allowlist and `/api/v1` prefix.
`FEEDBACK_TOPIC_ANALYSIS_ENABLED=true` permits new starts. Disabling it leaves
reads and recovery of already requested runs available. This is feature
enablement, not a new authorization role.

| Method | Path                                                                | Operation                        | Result                                                                      |
| ------ | ------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| POST   | `/feedback/campaigns/:campaignId/topic-analyses`                    | `startFeedbackTopicAnalysis`     | 202 with durable run ID/status                                              |
| GET    | `/feedback/campaigns/:campaignId/topic-analyses/:analysisId`        | `getFeedbackTopicAnalysis`       | Status, config, snapshot hash, observed usage                               |
| GET    | `/feedback/campaigns/:campaignId/topic-analyses/:analysisId/result` | `getFeedbackTopicAnalysisResult` | Complete persisted result and original input/provenance; 409 until complete |

Start accepts no model/configuration override. Empty/oversized input returns 400
without truncation or provider work. Missing campaign/run, or a run under the
wrong campaign, returns 404. Disabled starts return 403.

Repeating a start with the same snapshot and configuration returns the same run,
including completed or failed runs. There is no force/retry endpoint that resets
the paid-call budget. A changed input snapshot or explicitly versioned algorithm
configuration creates a separate run. Previous results remain tied to their
original snapshot; there is no ambiguous “latest result” endpoint.

Each document preserves note ID, conversation ID, respondent/optional subject
IDs, original text, note type, original source-message IDs, extraction
model/origin and note timestamps. The snapshot also records the campaign and
question-set version. There is no translation or new semantic normalization.
The embedding instruction is a fixed model task prefix; it does not rewrite the
stored note text.

## Flow and persistence

```mermaid
sequenceDiagram
  participant Admin
  participant Node
  participant PG as PostgreSQL
  participant Queue as BullMQ
  participant Provider as OpenRouter
  participant Python
  Admin->>Node: Start campaign topic analysis
  Node->>PG: Snapshot + unique run identity + audit, one transaction
  Node->>Queue: Identifier-only wake-up after commit
  Queue->>Node: Run ID
  Node->>PG: Claim deployment slot and run with token/epoch
  Node->>PG: Read cached vectors; reserve remaining request budget
  Node->>Provider: Bounded embedding batch
  Node->>PG: Commit cache + observed usage under live claim
  Node->>Python: One JSON request, then EOF
  Python-->>Node: Progress and one complete result
  Node->>Node: Validate exact coverage; count distinct respondents
  Node->>PG: Result + completed status + release, one transaction
```

`feedback_topic_analyses` stores immutable snapshot/configuration/result with
execution state. Unique `(campaign_id, identity_hash)` covers campaign, snapshot
version/content/provenance, embedding model/dimensions/instruction/routing and
clustering configuration/version. Snapshot/config hashes are revalidated before
provider entry. The service opens transactions; the repository receives the
explicit transaction for every participating write.

`feedback_topic_embeddings` caches campaign-scoped exact hashes of embedding
configuration and input. Vectors use PostgreSQL `real[]`, fixed 1024 dimensions,
finite values and nonzero norm. Node rounds new vectors to float32 before both
cache insertion and clustering, so fresh and resumed paths see the same
precision. Identical note text can share a vector while each note retains its
own document identity and assignment. No approximate similarity index is needed
for loading one bounded batch by exact cache key.

`feedback_topic_analysis_slot` is one deployment-wide leased slot. Transactions
lock it before the run row. Claims increment the run's epoch and durable attempt
count and assign a random token with a 15-minute lease. Renewals before provider
and Python entry extend both rows; the provider's 30-second and child's
180-second deadlines are shorter than the lease. Every cache/usage/failure/result
write locks and validates both live claims. An expired/replaced worker cannot
publish a result or cache write, even if its network request finishes later.

The cache survives run retries. Completion writes the entire result and terminal
status atomically and releases capacity in the same transaction. A transaction
rollback exposes neither completion nor a partial result. The Python result
must assign every snapshot ID exactly once, reference only declared topics,
declare unique topic IDs, and cite unique representatives assigned to that same
topic. A null topic is an outlier. Counts use distinct respondent IDs in Node,
including separate outlier counts; a respondent can support several topics, so
topic counts need not sum to campaign respondents. Keywords are descriptive
labels, not an LLM assessment or a participant ranking.

## Bounds and failure behavior

| Boundary              | Limit                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Input                 | 1–500 notes, 500 characters each; 256 KiB total embedding-input UTF-8 bytes plus two token-bound allowance units per document |
| Snapshot/result JSONB | 2 MiB each at PostgreSQL boundary; admission snapshot serialization ≤1.5 MB                                                   |
| Embeddings            | 1024 dimensions, ≤32 distinct texts/request, one request at a time, 30-second request deadline, 2 MiB response                |
| Durable paid budget   | ≤3 claimed attempts, ≤48 reserved requests, ≤768 KiB reserved input allowance over the run lifetime                           |
| Routing               | Qwen3 Embedding 8B, no fallback, required parameter support, prompt price ≤$0.01/M tokens and request price $0                |
| Python                | One child across the deployment's live lease; 180 seconds; ≤16 MiB stdin, ≤2 MiB result plus 4 KiB progress, ≤64 KiB stderr   |
| Queue                 | Worker concurrency 1, ≤3 BullMQ attempts (two retries) per wake-up, fixed 30-second backoff, one stalled retry                |
| Recovery              | Startup/every 30 seconds, ≤20 due runs/pass, `FOR UPDATE SKIP LOCKED`; allocation rotates `next_wakeup_at` before enqueue     |

The UTF-8 allowance conservatively bounds Qwen byte-token input without adding
a tokenizer or calling a provider just to count. Reservation happens **before**
each request. A crash can spend a reservation without saving its response.
There is no exactly-once paid-call claim: a network/commit crash can rebill a
batch on retry, within the durable lifetime ceiling. Observed prompt tokens,
response count and optional cost are saved from successful responses with cache
writes. `observedCostUsd` is a partial observed sum when a provider omits cost or
a crash loses a response; it is not a total invoice or a completeness claim.

Queue payload: `{ schemaVersion: 1, analysisId }`, name
`feedback.analyze-topics.v1`, stable ID `feedback-analyze-topics-v1-<analysisId>`.
Both ends validate it. PostgreSQL owns attempts and recovery, so removing a
retained job cannot reset budgets. Busy claims move to delayed without consuming
an attempt. Recovery replaces terminal retained wake-ups, preserves live ones,
and repairs commit/enqueue loss. The 30-second backoff is a delivery policy;
duplicate wake-ups can arrive sooner, but the durable claim/budget still bounds
execution. Redis availability never determines completion.

Missing key, rejected request/model/shape/dimensions, malformed Python output,
nonzero child exit and exhausted budgets fail permanently. HTTP 408/429/5xx,
network timeout, child cancellation/deadline and database outages are retryable
within three durable claims. Process death leaves the lease to expire; exhausted
claims become failed at the next recovery. No failure changes feedback notes or
the participant conversation.

## Python and Effect boundary

Wire v1 is documented beside [the Python package](../../../apps/topic-clustering/README.md).
Stdin receives one JSON object then EOF. Stdout JSONL contains at most four
progress records (`validate`, `reduce`, `cluster`, `describe`) and exactly one
terminal result, accepted only after clean process exit. Stderr is drained and
bounded, never forwarded into application logs.

Python normalizes vectors, reduces with PCA, runs sklearn HDBSCAN through
BERTopic 0.17.4 and describes topics with multilingual c-TF-IDF keywords.
Insufficient/tokenless samples return outliers; sufficiently supported identical
vectors can form one topic. No local embedding model, model download, translation
or mandatory LLM naming workflow is installed.

Nest owns DI and shutdown. The local Effect recipe makes embedding, clustering,
validation and commit stages visible. An `Effect.acquireRelease` scope owns the
Node child; no Effect Tags, Context, Layers or retry runtime is introduced.
`spawn` receives an executable and argv (`-I`, `-B`, script), never a shell.
Cancellation/deadline/shutdown sends SIGTERM, escalates to SIGKILL after 250 ms
if necessary and waits for the child to be reaped before the scope closes.
The child receives a small fixed environment without application credentials.

## Operations and verification

Run the migration before deploying the additive HTTP/worker modules. Defaults:
`FEEDBACK_TOPIC_ANALYSIS_ENABLED=false`,
`FEEDBACK_TOPIC_CLUSTERING_PYTHON=apps/topic-clustering/.venv/bin/python`,
`FEEDBACK_TOPIC_CLUSTERING_SCRIPT=apps/topic-clustering/cluster.py`.
Relative paths resolve from repository root in source and compiled backend
layouts. Production uses `/opt/topic-clustering/.venv/bin/python` and
`/opt/topic-clustering/cluster.py`. The worker uses the existing
`OPENROUTER_API_KEY`; HTTP holds no embedding client. Install and deployment
commands live in [deployment](../../deployment.md).

Logs use `feedback.operation`, operation `topic_analysis`, internal IDs,
attempt/epoch and stages `embed_notes`, `cluster_notes`, `cluster_*`,
`validate_result`, `commit_result`. Failures are sanitized codes. No note text,
vectors, provider response, credential or Python stderr is logged. Queue and
recovery warnings are observations; they never authorize writes.

Focused suites cover provider request/response validation, actual subprocess
completion/cancellation/reaping/overflow, HTTP 401/403/202 and module composition.
The opt-in `FEEDBACK_POSTGRES_TEST_URL` suite applies migrations only to an
explicitly disposable database and verifies concurrent idempotency, deployment
capacity, stale writes, result rollback, cache preservation and lifetime budgets.
Run it through `pnpm test:feedback:postgres`; run `pnpm test:topic-clustering`
for the CPU implementation and `pnpm check` before handoff. Initial SQL checks
ran on disposable PostgreSQL 16.15; deployment remains PostgreSQL 18.4.

The offline Node-to-Python bridge verifies real Greek keywords and assignments.
It does not measure semantic quality of Greek/Greeklish embeddings. No paid
quality experiment was performed. Live OpenRouter request compatibility remains
unverified without a configured key. Future semantic research should first add
real query/filter/recall requirements, then consider a pgvector migration over
the existing cached arrays rather than creating a second store preemptively.
