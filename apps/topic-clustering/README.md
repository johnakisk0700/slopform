# Offline campaign topic clustering

`cluster.py` owns one CPU clustering pass over findings and embeddings supplied
by Node. It does not own embedding generation, HTTP, credentials, persistence,
job retries or human topic names. Node must close stdin, bound subprocess
concurrency and elapsed time, terminate on cancellation, and validate the entire
result before committing it. See the [campaign analysis mechanism](../../docs/backend/modules/campaign-topic-analysis.md).

## Install and verify

Verified **2026-09-08**, CPython **3.12.3** and an isolated **3.11.14** runtime on
Linux x86_64; both installed the hash-checked lock and passed all eleven tests.
Supported interpreter range: Python **3.11–3.12**. The container uses Debian
bookworm Python 3.11; this local verification did not build or run that image.
All runtime dependencies have exact versions and wheel SHA-256 hashes in
`requirements.lock`; `requirements.in` is the reviewed dependency inventory.

From the repository root, the public commands are `pnpm topic-clustering:setup`
and `pnpm test:topic-clustering`. Equivalent isolated commands:

```bash
python3 -m venv apps/topic-clustering/.venv
apps/topic-clustering/.venv/bin/python -m pip install \
  --no-deps --require-hashes --only-binary=:all: \
  -r apps/topic-clustering/requirements.lock
apps/topic-clustering/.venv/bin/python -I -B -m unittest discover \
  -s apps/topic-clustering/tests -p 'test_*.py'
```

Use `--no-deps`: BERTopic's package metadata otherwise installs unused neural
embedding dependencies. This is the library's documented lightweight install,
with explicit runtime dependencies. `pip check` consequently reports those
intentionally omitted optional capabilities as missing; the real offline tests
verify the supported path. Installed: BERTopic **0.17.4**, scikit-learn **1.7.2**,
NumPy **2.2.6**, SciPy **1.16.3**, pandas **2.3.3**, and nine small dependencies.
No PyTorch, CUDA, sentence-transformers, Hugging Face client, UMAP, Numba, plotly,
or standalone `hdbscan` package is required. These core libraries use permissive
MIT/BSD licenses; retain their distribution license notices.

After reviewing dependency upgrades, run
`python3 apps/topic-clustering/lock_dependencies.py` to fetch hashes from PyPI
for every wheel of the exact listed versions. This maintenance command needs
network access; clustering and tests do not. Recreate the venv and rerun tests.
The lock supports published wheels across platforms; only Linux x86_64 was
executed here. Never remove `--only-binary` to silently compile another platform.

## JSONL protocol v1

Invoke the Python executable directly with `-I -B /path/to/cluster.py`, without a
shell. Send one UTF-8 JSON object on stdin, then EOF:

```json
{
  "version": 1,
  "requestId": "analysis-run-id",
  "documents": [
    {
      "id": "finding-id",
      "text": "Ο ήχος ήταν χαμηλός",
      "embedding": [0.3, 0.8]
    }
  ],
  "options": { "minTopicSize": 3, "minSamples": 2, "randomSeed": 42 }
}
```

Stdout contains only JSON objects, one per line. Progress means a stage has
started; there are no synthetic percentages:

```jsonl
{"version":1,"requestId":"analysis-run-id","type":"progress","stage":"validate"}
{"version":1,"requestId":"analysis-run-id","type":"result","topics":[],"assignments":[{"documentId":"finding-id","topicId":null}]}
```

A normal clustering run emits `validate`, `reduce`, `cluster`, `describe`, then
one result. `cluster` covers BERTopic fitting, including its c-TF-IDF calculation;
`describe` extracts output keywords and representative IDs. Degenerate inputs
can finish after `validate`. The result shape for each topic is
`{id: string, keywords: string[], representativeDocumentIds: string[]}`. Every
input ID appears exactly once in assignments. `topicId: null` is an explicit
outlier; all other IDs reference returned topics. Topic IDs are numeric strings
local to a run, with no stable taxonomy promise. Representatives belong to the
same topic and are unique, even when multiple findings have identical text.

The envelope, document and options fields are exact; unknown fields and duplicate
JSON keys are rejected. Bounds:

| Input/output    | Limit                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Entire input    | 16 MiB before JSON parsing                                                                            |
| Documents       | 0–1,000; unique IDs                                                                                   |
| ID / request ID | 1–128 printable characters, no surrounding whitespace                                                 |
| Finding text    | 1–8,000 characters; nonblank; no unpaired UTF-16 surrogates                                           |
| Embedding       | 1–4,096 dimensions, equal across all documents, finite numbers and nonzero norm                       |
| Options         | `minTopicSize`: 2–1,000; `minSamples`: 1–1,000; `randomSeed`: 0–4,294,967,295; integers, not booleans |
| Result line     | At most 2 MiB; up to 10 keywords/topic, 80 characters/keyword, 3 representatives/topic                |

These limits apply together: 1,000 high-dimensional JSON vectors can exceed the
byte ceiling. Node may apply stricter limits. No raw finding text or vectors are
printed to stderr. Exit `0` means a result was emitted, `2` means invalid input,
and `1` means another failure (only its exception class is logged). A partial
progress stream followed by nonzero exit is a failed run, never usable output.

## Algorithm and limits

1. Sort documents by ID, then normalize each nonzero embedding to unit L2 norm.
   Scale by its largest coordinate first to avoid numeric overflow. This assumes
   the supplied embedding model uses angular similarity; magnitude is discarded.
2. Use seeded randomized PCA with at most five components (also capped by
   dimensions and document count minus one). This deliberately uses BERTopic's
   supported PCA alternative to its usual UMAP reduction, avoiding JIT warm-up
   and its dependency stack. PCA can lose distinctions in small/minority groups;
   five components is an initial bounded configuration, not a quality claim.
3. Real BERTopic fits scikit-learn HDBSCAN over those reduced vectors using
   Euclidean distance, excess-of-mass selection, one job, and
   `allow_single_cluster=False`. PCA changes the original angular geometry;
   these distances are not exact cosine distances. scikit-learn's `minSamples`
   includes the point itself (unlike the separate `hdbscan` library).
4. BERTopic computes c-TF-IDF keywords with frequent-word reduction. Explicit
   `language="multilingual"` preserves Greek during BERTopic preprocessing;
   its default English mode strips non-ASCII characters before tokenization.
   Precomputed vectors still bypass embedding model selection/downloads. Tokenization
   preserves Unicode Greek, English and Greeklish words, including single-letter
   words; it makes no translation or stemming claim. Vocabulary is capped at
   20,000 terms. Topic representatives are the three members most similar to
   their original normalized-vector centroid, with ID-based tie breaking.

Empty inputs, fewer documents than `minTopicSize`, document counts no greater
than `minSamples`, and an entirely tokenless corpus return explicit all-outlier
results. With enough support, exactly identical normalized vectors form one
topic using BERTopic’s public manual-label path (`BaseCluster` and `y`), avoiding
degenerate PCA. This assumes identical provider vectors are repeated semantic
evidence; Python cannot detect an embedding provider returning a constant vector
by mistake. Zero vectors are invalid input. For nonidentical vectors, HDBSCAN may
return all outliers: it never forces a category for one dense group, merges small
groups by fiat, or reassigns noise.
Nonlexical members can still cluster when the corpus has words; such a topic may
have no keywords. Findings are never omitted to make the result look complete.

The same seed and canonical input order reproduce this pinned Linux smoke,
including after request reordering. They do not guarantee equivalent partitions
across library upgrades, architectures or datasets, or useful Greek/Greeklish
categories. Quality requires review on representative real findings.

## Operations and evidence

BLAS/OpenMP thread counts are forcibly set to one before numerical imports,
with `threadpoolctl` also bounding active pools. The executable disables Python
bytecode writes, does not save models, and enables Hugging Face offline flags.
No writable source/cache directory is needed. Node owns the wall-clock timeout;
input bounds and one thread are not hard operating-system memory/CPU quotas.
The worker container's limits remain the resource boundary.

A fresh subprocess smoke on this Linux development host (Python 3.12.3,
300 synthetic findings × 1,024 dimensions, three separated groups) took **1.00 s
wall time** and **184,384 KiB peak RSS** (`/usr/bin/time`, including imports).
It returned three topics and all 300 assignments; input was 6,974,185 bytes and
output 13,917 bytes. The fixture used `random.Random(7)`, Gaussian noise with
standard deviation 0.012, and three unit-coordinate centers (100 findings each),
with options `minTopicSize=3`, `minSamples=2`, `randomSeed=42`.
These are one local fixture's measurements, not production-scale or language
quality guarantees.

The unittest suite exercises malformed JSON/schema, duplicate IDs, vector/text
bounds, empty and degenerate data, all outliers, repeated texts/vectors, Unicode
keywords, representative membership, and deterministic repeated/reordered runs.
Its real BERTopic smoke uses synthetic precomputed vectors; a process audit hook
rejects network operations before third-party imports and verifies an empty
model-cache directory. It also asserts the neural packages are absent.

## Primary references

- [BERTopic lightweight installation](https://maartengr.github.io/BERTopic/getting_started/tips_and_tricks/tips_and_tricks.html#lightweight-installation)
- [Precomputed embeddings](https://maartengr.github.io/BERTopic/getting_started/tips_and_tricks/tips_and_tricks.html#pre-compute-embeddings)
- [BERTopic PCA reduction](https://maartengr.github.io/BERTopic/getting_started/dim_reduction/dim_reduction.html#pca)
- [BERTopic manual topic labels](https://maartengr.github.io/BERTopic/getting_started/manual/manual.html)
- [scikit-learn HDBSCAN API and min_samples semantics](https://scikit-learn.org/1.7/modules/generated/sklearn.cluster.HDBSCAN.html)
- [BERTopic 0.17.4 release](https://pypi.org/project/bertopic/0.17.4/)
