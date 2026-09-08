"""Cluster one bounded, pre-embedded feedback snapshot over JSONL protocol v1."""

import contextlib
import json
import math
import os
import re
import sys

# Set before importing numerical libraries; never inherit an oversized host pool.
sys.dont_write_bytecode = True
for variable in (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "BLIS_NUM_THREADS",
):
    os.environ[variable] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_DOCUMENTS = 1000
MAX_DIMENSIONS = 4096
MAX_TEXT_LENGTH = 8000
MAX_ID_LENGTH = 128
MAX_KEYWORDS = 10
MAX_KEYWORD_LENGTH = 80
WORD_PATTERN = re.compile(r"(?u)\b\w+\b")


class ProtocolError(ValueError):
    """A bounded, safe diagnostic that contains no supplied values."""


def main():
    try:
        request = read_request(sys.stdin.buffer)
        request_id = request["requestId"]
        emit_message(request_id, "progress", stage="validate")
        documents = validate_documents(request["documents"])
        options = validate_options(request["options"])
        topics, assignments = cluster_documents(documents, options, request_id)
        emit_message(request_id, "result", topics=topics, assignments=assignments)
        return 0
    except ProtocolError as error:
        print(f"topic-clustering: invalid request: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        # Third-party exception messages can contain input text or vector values.
        print(f"topic-clustering: failed ({type(error).__name__})", file=sys.stderr)
        return 1


def read_request(stream):
    data = stream.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ProtocolError("input exceeds byte limit")
    try:
        request = json.loads(
            data.decode("utf-8"),
            parse_constant=reject_json_constant,
            object_pairs_hook=reject_duplicate_keys,
        )
    except (UnicodeError, ValueError, RecursionError):
        raise ProtocolError("expected one UTF-8 JSON object") from None
    require_keys(request, {"version", "requestId", "documents", "options"})
    if type(request["version"]) is not int or request["version"] != 1:
        raise ProtocolError("unsupported protocol version")
    validate_identifier(request["requestId"])
    return request


def reject_json_constant(_value):
    raise ProtocolError("nonfinite JSON number")


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("duplicate JSON key")
        result[key] = value
    return result


def require_keys(value, keys):
    if not isinstance(value, dict) or set(value) != keys:
        raise ProtocolError("unexpected object fields")


def validate_identifier(value):
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= MAX_ID_LENGTH
        or not value.isprintable()
        or value != value.strip()
    ):
        raise ProtocolError("invalid identifier")


def validate_documents(documents):
    if not isinstance(documents, list) or len(documents) > MAX_DOCUMENTS:
        raise ProtocolError("invalid document count")
    identifiers = set()
    dimensions = None
    for document in documents:
        require_keys(document, {"id", "text", "embedding"})
        validate_identifier(document["id"])
        if document["id"] in identifiers:
            raise ProtocolError("duplicate document identifier")
        identifiers.add(document["id"])
        text = document["text"]
        if (
            not isinstance(text, str)
            or not text.strip()
            or len(text) > MAX_TEXT_LENGTH
            or any(0xD800 <= ord(character) <= 0xDFFF for character in text)
        ):
            raise ProtocolError("invalid document text")
        embedding = document["embedding"]
        if not isinstance(embedding, list) or not 1 <= len(embedding) <= MAX_DIMENSIONS:
            raise ProtocolError("invalid embedding dimensions")
        if dimensions is not None and len(embedding) != dimensions:
            raise ProtocolError("inconsistent embedding dimensions")
        dimensions = len(embedding)
        for value in embedding:
            try:
                valid = type(value) in (int, float) and math.isfinite(value)
            except OverflowError:
                valid = False
            if not valid:
                raise ProtocolError("embedding must contain finite numbers")
        if not any(value != 0 for value in embedding):
            raise ProtocolError("embedding must have nonzero norm")
    return sorted(documents, key=lambda document: document["id"])


def validate_options(options):
    require_keys(options, {"minTopicSize", "minSamples", "randomSeed"})
    bounds = {
        "minTopicSize": (2, MAX_DOCUMENTS),
        "minSamples": (1, MAX_DOCUMENTS),
        "randomSeed": (0, 2**32 - 1),
    }
    for name, (minimum, maximum) in bounds.items():
        if type(options[name]) is not int or not minimum <= options[name] <= maximum:
            raise ProtocolError("invalid clustering options")
    return options


def extract_words(text):
    return [
        word
        for word in WORD_PATTERN.findall(text.lower())
        if len(word) <= MAX_KEYWORD_LENGTH
    ]


def cluster_documents(documents, options, request_id):
    if (
        len(documents) < options["minTopicSize"]
        or len(documents) <= options["minSamples"]
        or not any(extract_words(document["text"]) for document in documents)
    ):
        return [], assign_outliers(documents)

    # Keep imports off the empty/invalid-input path; this process owns no embedder.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        from bertopic import BERTopic
        from bertopic.cluster import BaseCluster
        from bertopic.dimensionality import BaseDimensionalityReduction
        from bertopic.vectorizers import ClassTfidfTransformer
        from sklearn.cluster import HDBSCAN
        from sklearn.decomposition import PCA
        from sklearn.feature_extraction.text import CountVectorizer
        from threadpoolctl import threadpool_limits

        emit_message(request_id, "progress", stage="reduce")
        embeddings = normalize_embeddings(documents, np)
        identical_vectors = bool(np.all(embeddings == embeddings[0]))

        with threadpool_limits(limits=1):
            # Repeated identical meaning is supported evidence for one topic.
            # Fit BERTopic's public manual-label path without degenerate PCA.
            if identical_vectors:
                reduced_embeddings = embeddings
                cluster_model = BaseCluster()
            else:
                reduced_embeddings = PCA(
                    n_components=min(5, len(documents) - 1, embeddings.shape[1]),
                    svd_solver="randomized",
                    random_state=options["randomSeed"],
                ).fit_transform(embeddings)
                cluster_model = HDBSCAN(
                    min_cluster_size=options["minTopicSize"],
                    min_samples=options["minSamples"],
                    metric="euclidean",
                    cluster_selection_method="eom",
                    allow_single_cluster=False,
                    n_jobs=1,
                )
            model = BERTopic(
                # English mode strips Greek before the Unicode tokenizer runs.
                language="multilingual",
                embedding_model=None,
                umap_model=BaseDimensionalityReduction(),
                hdbscan_model=cluster_model,
                vectorizer_model=CountVectorizer(
                    tokenizer=extract_words,
                    token_pattern=None,
                    lowercase=False,
                    max_features=20_000,
                ),
                ctfidf_model=ClassTfidfTransformer(reduce_frequent_words=True),
                top_n_words=MAX_KEYWORDS,
                calculate_probabilities=False,
                verbose=False,
            )
            emit_message(request_id, "progress", stage="cluster")
            labels, _ = model.fit_transform(
                [document["text"] for document in documents],
                embeddings=reduced_embeddings,
                y=[0] * len(documents) if identical_vectors else None,
            )
            emit_message(request_id, "progress", stage="describe")
            return describe_topics(model, documents, embeddings, labels)


def normalize_embeddings(documents, np):
    embeddings = np.asarray(
        [document["embedding"] for document in documents], dtype=np.float64
    )
    # Scaling first avoids overflow/underflow with arbitrary finite input vectors.
    embeddings /= np.max(np.abs(embeddings), axis=1, keepdims=True)
    return embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)


def assign_outliers(documents):
    return [{"documentId": document["id"], "topicId": None} for document in documents]


def describe_topics(model, documents, embeddings, labels):
    assignments = [
        {"documentId": document["id"], "topicId": str(label) if label >= 0 else None}
        for document, label in zip(documents, labels, strict=True)
    ]
    topics = []
    for label in sorted(set(labels) - {-1}):
        indices = [index for index, assigned in enumerate(labels) if assigned == label]
        centroid = embeddings[indices].mean(axis=0)
        similarities = embeddings[indices] @ centroid
        ranked_indices = sorted(
            range(len(indices)),
            key=lambda position: (
                -float(similarities[position]),
                documents[indices[position]]["id"],
            ),
        )
        keywords = [
            word
            for word, weight in model.get_topic(label)
            if word and math.isfinite(weight) and weight > 0
        ]
        topics.append(
            {
                "id": str(label),
                "keywords": list(dict.fromkeys(keywords))[:MAX_KEYWORDS],
                "representativeDocumentIds": [
                    documents[indices[position]]["id"]
                    for position in ranked_indices[:3]
                ],
            }
        )
    return topics, assignments


def emit_message(request_id, message_type, **payload):
    message = {"version": 1, "requestId": request_id, "type": message_type, **payload}
    serialized = json.dumps(
        message, ensure_ascii=True, allow_nan=False, separators=(",", ":")
    )
    if len(serialized) + 1 > MAX_OUTPUT_BYTES:
        raise RuntimeError("output exceeds byte limit")
    # __stdout__ remains the protocol stream when library stdout is redirected.
    print(serialized, file=sys.__stdout__, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
