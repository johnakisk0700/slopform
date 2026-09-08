"""Protocol tests include an actual offline BERTopic run, never a fake model."""

import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIRECTORY))
import cluster  # noqa: E402 - standalone script, imported after adding its directory.


def make_request(documents=None, **options):
    return {
        "version": 1,
        "requestId": "offline-test",
        "documents": documents or [],
        "options": {"minTopicSize": 3, "minSamples": 2, "randomSeed": 42, **options},
    }


def make_documents():
    random_generator = random.Random(7)
    documents = []
    for group, text in enumerate(
        (
            "Καλή οργάνωση εκδήλωσης helpful organization",
            "Ήχος μικρόφωνο sound microphone",
            "Φαγητό καφές food coffee",
        )
    ):
        for index in range(12):
            vector = [random_generator.gauss(0, 0.012) for _ in range(12)]
            vector[group] += 1
            documents.append(
                {"id": f"group-{group}-{index:02}", "text": text, "embedding": vector}
            )
    return documents


def run_request(request, offline=False):
    raw = request if isinstance(request, bytes) else json.dumps(request).encode()
    command = [sys.executable, "-I", "-B", str(DIRECTORY / "cluster.py")]
    with tempfile.TemporaryDirectory() as cache_directory:
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "HF_HOME": cache_directory,
            "XDG_CACHE_HOME": cache_directory,
            # Verify that the child overrides excessive inherited thread settings.
            "OPENBLAS_NUM_THREADS": "48",
        }
        if offline:
            # A subprocess-wide audit hook fails any attempted DNS/connect/send;
            # installed before BERTopic or any of its libraries are imported.
            guard = (
                "import runpy,sys; "
                "sys.addaudithook(lambda event,args: "
                "(_ for _ in ()).throw(RuntimeError('network prohibited')) "
                "if event in ('socket.connect','socket.getaddrinfo','socket.sendto') else None); "
                f"runpy.run_path({str(DIRECTORY / 'cluster.py')!r}, run_name='__main__')"
            )
            command = [sys.executable, "-I", "-B", "-c", guard]
        result = subprocess.run(
            command, input=raw, capture_output=True, env=environment, timeout=30
        )
        if offline and any(Path(cache_directory).iterdir()):
            raise AssertionError("Offline clustering wrote a model/cache file")
    return result, [json.loads(line) for line in result.stdout.splitlines()]


class ProtocolTests(unittest.TestCase):
    def assert_invalid(self, request):
        result, messages = run_request(request)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(any(message["type"] == "result" for message in messages))
        self.assertNotIn(b"SENSITIVE_FEEDBACK", result.stderr)

    def test_malformed_json_and_envelopes(self):
        for raw in (
            b"not json SENSITIVE_FEEDBACK",
            b"{} {}",
            b"[]",
            b"\xff",
            b'{"version":1,"version":1}',
            json.dumps(make_request())
            .replace('"version": 1', '"version": true')
            .encode(),
        ):
            with self.subTest(raw=raw):
                self.assert_invalid(raw)
        for name, value in (
            ("version", 2),
            ("requestId", "bad\nidentifier"),
            ("documents", {}),
            ("options", {}),
        ):
            request = make_request()
            request[name] = value
            self.assert_invalid(request)
        request = make_request()
        request["extra"] = "SENSITIVE_FEEDBACK"
        self.assert_invalid(request)

    def test_rejects_bad_documents_without_echoing_feedback(self):
        original = {"id": "one", "text": "SENSITIVE_FEEDBACK", "embedding": [1, 2]}
        for field, value in (
            ("id", ""),
            ("id", "a" * 129),
            ("text", " "),
            ("text", "a" * 8001),
            ("text", "\ud800"),
            ("embedding", []),
            ("embedding", [0, 0]),
            ("embedding", [True, 0]),
            ("embedding", [float("nan"), 1]),
            ("embedding", [float("inf"), 1]),
            ("embedding", ["1", 0]),
            ("embedding", [10**400, 1]),
            ("embedding", [1] * 4097),
        ):
            with self.subTest(field=field, value_type=type(value).__name__):
                document = {**original, field: value}
                self.assert_invalid(make_request([document]))
        self.assert_invalid(make_request([original, original]))
        self.assert_invalid(
            make_request([original, {**original, "id": "two", "embedding": [1]}])
        )
        self.assert_invalid(make_request([original] * 1001))

    def test_options_bounds_and_boolean_numbers(self):
        for name, value in (
            ("minTopicSize", 1),
            ("minTopicSize", 1001),
            ("minSamples", 0),
            ("minSamples", 1001),
            ("randomSeed", -1),
            ("randomSeed", 2**32),
            ("randomSeed", True),
            ("minSamples", 1.5),
        ):
            self.assert_invalid(make_request(**{name: value}))

    def test_input_byte_limit_is_enforced(self):
        self.assert_invalid(b" " * (cluster.MAX_INPUT_BYTES + 1))

    def test_empty_singleton_and_too_few_documents_preserve_identity(self):
        for count in range(4):
            documents = [
                {"id": str(index), "text": "ήχος", "embedding": [1, index]}
                for index in range(count)
            ]
            result, messages = run_request(make_request(documents, minTopicSize=4))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(messages[-1]["topics"], [])
            self.assertEqual(
                messages[-1]["assignments"], cluster.assign_outliers(documents)
            )



class OfflineClusteringTests(unittest.TestCase):
    def assert_valid_result(self, messages, documents):
        self.assertEqual(messages[-1]["type"], "result")
        for message in messages:
            self.assertEqual(message["version"], 1)
            self.assertEqual(message["requestId"], "offline-test")
        result = messages[-1]
        assignments = result["assignments"]
        self.assertEqual(
            sorted(item["documentId"] for item in assignments),
            sorted(document["id"] for document in documents),
        )
        topic_ids = [topic["id"] for topic in result["topics"]]
        self.assertEqual(len(topic_ids), len(set(topic_ids)))
        self.assertTrue(
            all(
                item["topicId"] is None or item["topicId"] in topic_ids
                for item in assignments
            )
        )
        assigned_topics = {item["documentId"]: item["topicId"] for item in assignments}
        for topic in result["topics"]:
            self.assertTrue(0 < len(topic["representativeDocumentIds"]) <= 3)
            self.assertEqual(
                len(topic["representativeDocumentIds"]),
                len(set(topic["representativeDocumentIds"])),
            )
            self.assertTrue(
                all(
                    assigned_topics[document_id] == topic["id"]
                    for document_id in topic["representativeDocumentIds"]
                )
            )
            self.assertLessEqual(len(topic["keywords"]), 10)
        return result

    def test_real_bertopic_smoke_offline_repeats_and_reorders(self):
        documents = make_documents()
        request = make_request(documents)
        results = []
        for ordered_documents in (documents, documents, list(reversed(documents))):
            request["documents"] = ordered_documents
            process, messages = run_request(request, offline=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(process.stderr, b"")
            result = self.assert_valid_result(messages, documents)
            self.assertEqual(len(result["topics"]), 3)
            self.assertTrue(
                any(
                    any("\u0370" <= character <= "\u03ff" for character in word)
                    for topic in result["topics"]
                    for word in topic["keywords"]
                )
            )
            self.assertTrue(
                all(
                    assignment["topicId"] is not None
                    for assignment in result["assignments"]
                )
            )
            # Repeated identical text has distinct IDs; all twelve members survive.
            for group in range(3):
                assigned = {
                    item["topicId"]
                    for item in result["assignments"]
                    if item["documentId"].startswith(f"group-{group}-")
                }
                self.assertEqual(len(assigned), 1)
            results.append(result)
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0], results[2])

    def test_small_greek_only_corpus_preserves_words_and_both_groups(self):
        documents = [
            {
                "id": str(index),
                "text": "κακός ήχος στη μουσική"
                if index < 3
                else "όμορφη βραδιά μουσικής",
                "embedding": [1, 0, 0] if index < 3 else [0, 1, 0],
            }
            for index in range(6)
        ]
        process, messages = run_request(make_request(documents), offline=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stderr, b"")
        result = self.assert_valid_result(messages, documents)
        self.assertEqual(len(result["topics"]), 2)
        assignments = {
            item["documentId"]: item["topicId"] for item in result["assignments"]
        }
        self.assertEqual(assignments["0"], assignments["1"])
        self.assertEqual(assignments["1"], assignments["2"])
        self.assertEqual(assignments["3"], assignments["4"])
        self.assertEqual(assignments["4"], assignments["5"])
        self.assertNotEqual(assignments["0"], assignments["3"])
        keywords = {word for topic in result["topics"] for word in topic["keywords"]}
        self.assertTrue({"ήχος", "μουσική", "βραδιά", "μουσικής"} <= keywords)

    def test_duplicate_vectors_have_one_topic_and_punctuation_only_abstains(self):
        for text, expected_topics in (("ίδιο same feedback", 1), ("!!!", 0)):
            documents = [
                {"id": str(index), "text": text, "embedding": [1, 2]}
                for index in range(8)
            ]
            process, messages = run_request(make_request(documents), offline=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            result = self.assert_valid_result(messages, documents)
            self.assertEqual(len(result["topics"]), expected_topics)
            self.assertTrue(
                all(
                    (item["topicId"] is not None) == bool(expected_topics)
                    for item in result["assignments"]
                )
            )

    def test_distinct_vectors_can_all_be_outliers(self):
        documents = make_documents()[:8]
        process, messages = run_request(
            make_request(documents, minTopicSize=5, minSamples=4), offline=True
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        result = self.assert_valid_result(messages, documents)
        self.assertEqual(result["topics"], [])
        self.assertTrue(all(item["topicId"] is None for item in result["assignments"]))

    def test_identical_vectors_within_distinct_groups_and_nonlexical_group(self):
        documents = []
        for group, text in enumerate(("ήχος sound", "!!!", "food καφές")):
            for index in range(6):
                documents.append(
                    {
                        "id": f"{group}-{index}",
                        "text": text,
                        "embedding": [int(axis == group) for axis in range(3)],
                    }
                )
        process, messages = run_request(make_request(documents), offline=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = self.assert_valid_result(messages, documents)
        self.assertEqual(len(result["topics"]), 3)


if __name__ == "__main__":
    unittest.main()
