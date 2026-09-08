# ADR 0018: Bounded campaign topic analysis with PostgreSQL and a Python subprocess

- Status: Accepted
- Date: 2026-09-08
- Scope: Explicitly requested topic analysis of extracted campaign feedback notes.

## Decision

Keep PostgreSQL as the only persistence owner. Store immutable bounded input
snapshots and complete results as JSONB and cached 1024-dimensional embeddings
as `real[]`. Node owns every write, durable idempotency, transaction, embedding
request and respondent count. Python receives bounded JSON over stdin, computes
BERTopic topics with supplied embeddings, and emits validated JSONL; it has no
database access, credentials or HTTP service.

Use OpenRouter `qwen/qwen3-embedding-8b` with a versioned English clustering task
instruction and 1024 output dimensions. Keep note text and source-message IDs
unchanged. Use BERTopic 0.17.4 with PCA and sklearn HDBSCAN on CPU, c-TF-IDF
keywords and no local language model or mandatory LLM labeling call.

The [module contract](../backend/modules/campaign-topic-analysis.md) owns exact
limits, HTTP routes, queue envelopes and failure behavior. The initial scope
excludes staff/dismissed/fallback notes and does not represent all campaign
feedback. Existing summaries and live extraction remain separate.

## Embedding choice and evidence

Read-only official catalog/pricing verification on 2026-09-08:

| OpenRouter model              | Input USD/M tokens | Context | Dimension considerations |
| ----------------------------- | ------------------ | ------- | ------------------------ |
| Qwen3 Embedding 8B            | $0.01 minimum      | 32,768  | 32–4096; request 1024    |
| Qwen3 Embedding 4B            | $0.02              | 32,768  | Up to 2560               |
| OpenAI text-embedding-3-small | $0.02              | 8192    | 1536 default; reducible  |
| OpenAI text-embedding-3-large | $0.13              | 8192    | 3072 default; reducible  |
| Google Gemini Embedding 2     | $0.20              | 8192    | Up to 3072; reducible    |

Prices are catalog observations, not a future price guarantee. Qwen8B's live
OpenRouter page listed Nebius/DeepInfra at $0.01 and SiliconFlow at $0.04 per
million tokens. Request routing caps prompt price at $0.01/M, rejects per-request
charges, disables fallback and requires parameter support; response dimension
validation rejects ignored dimension requests. No automatic model substitution.
Sources: [OpenRouter embedding catalog](https://openrouter.ai/api/v1/models?output_modalities=embeddings),
[Qwen8B pricing](https://openrouter.ai/qwen/qwen3-embedding-8b),
[provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Qwen's model card reports support for more than 100 languages and evaluates text
clustering and multilingual MTEB (70.58 for 8B, June 2025). It supports task
instructions and reduced dimensions. This is evidence of multilingual/clustering
capability, **not a measured Greek or Greeklish quality result on our feedback**.
The sources reviewed do not establish a Greeklish winner. No paid quality test
or research framework was added. The cheap 8B route and adjustable dimensions
make it a reasonable initial value choice while retaining a versioned switch
point. Source: [Qwen official model card](https://huggingface.co/Qwen/Qwen3-Embedding-8B).

OpenRouter documents `dimensions`, `input_type` and provider routing for
embeddings. Its public request contract does not document Google's task-type
mapping, so this implementation does not assume that an undocumented
`CLUSTERING` field reaches Google. Qwen's explicit task prefix is included in
the cache/run identity. Sources: [OpenRouter embeddings API](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings),
[Google embeddings](https://ai.google.dev/gemini-api/docs/embeddings).

## Storage alternatives

| Option                               | Fit for this workload                                                     | Tradeoff                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Existing PostgreSQL `real[]` + JSONB | Exact cached-vector lookup and loading ≤500 notes for batch clustering    | No vector similarity operators/index until added                                                         |
| pgvector in the same PostgreSQL      | Useful for future semantic query/filter/ranking                           | Adds extension installation and index/recall choices without helping today's batch lookup                |
| Separate vector database             | Useful for independently scaled retrieval with concrete operational needs | Adds duplicate identities, consistency, backup and access boundaries without a current query requirement |

Typed float32 arrays are smaller and clearer for numerical vectors than JSONB.
JSONB fits heterogeneous provenance/configuration/results. A later pgvector
migration can cast/index compatible 1024-dimensional arrays alongside existing
metadata. pgvector supports exact and approximate search; its ordinary `vector`
HNSW/IVFFlat indexes support up to 2000 dimensions. These benefits do not require
a separate vector service. Source: [pgvector primary documentation](https://github.com/pgvector/pgvector).

## Durable execution and local Effect scope

A unique campaign/snapshot/config identity survives duplicate requests and job
retention. A global PostgreSQL slot and per-run epoch/token/lease fence concurrent
workers and late completions. Committed embedding batches survive retries.
Request/input reservations precede provider calls, and all attempts share one
lifetime budget. Network/commit crash windows can still duplicate paid calls;
observed token/cost counters cover only committed responses. The final result
and completed state commit atomically after full snapshot coverage validation.

Extend [ADR 0017](0017-effect-for-local-workflows.md) narrowly for ownership of
the new child process. Nest still owns DI/lifecycle; the domain recipe uses
existing Promise methods. `Effect.acquireRelease` and scoped cleanup acquire,
cancel, kill and reap the Node-spawned child. There are no Tags, Context, Layers,
provider retry loops or second durable workflow runtime. This new resource
scope does not change cancellation semantics of the existing live extraction.

The Python package pins BERTopic 0.17.4 and its minimal CPU numerical
dependencies, documented in [its README](../../apps/topic-clustering/README.md).
It avoids torch/transformers and downloads by using externally supplied vectors.
The subprocess protocol is versioned independently of configuration identity.

## Verification and extension

Focused provider, real subprocess, HTTP and PostgreSQL tests cover bounds,
identity/replay, stale writes, cache preservation and atomic completion.
Offline Python tests and a real Node-to-Python bridge exercise Greek keyword
preservation; they do not validate embedding semantic quality. Live OpenRouter
compatibility requires a key and remains an explicit verification limitation.

Changing input selection, embedding model/task/dimensions or clustering behavior
requires a configuration/input version and reviewed persisted compatibility.
Add semantic retrieval only after its query workload is concrete. Future
human-readable labels remain optional and must not invent support counts or
change assignments/provenance.
