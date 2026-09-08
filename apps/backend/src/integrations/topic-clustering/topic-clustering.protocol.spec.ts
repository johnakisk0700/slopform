import { describe, expect, it } from "vitest";
import { validateClusteringResult } from "./topic-clustering.protocol.js";
const result = {
  version: 1,
  requestId: "run",
  type: "result",
  topics: [
    { id: "topic", keywords: ["food"], representativeDocumentIds: ["a"] },
  ],
  assignments: [
    { documentId: "a", topicId: "topic" },
    { documentId: "b", topicId: null },
  ],
};
describe("clustering snapshot coverage", () => {
  it("accepts complete assignments including outliers", () =>
    expect(validateClusteringResult(result, "run", ["a", "b"])).toEqual(
      result,
    ));
  it.each([
    { ...result, requestId: "other" },
    { ...result, assignments: result.assignments.slice(0, 1) },
    { ...result, assignments: [result.assignments[0], result.assignments[0]] },
    {
      ...result,
      assignments: [
        { documentId: "invented", topicId: "topic" },
        result.assignments[1],
      ],
    },
    {
      ...result,
      assignments: [
        result.assignments[0],
        { documentId: "b", topicId: "invented" },
      ],
    },
    {
      ...result,
      topics: [{ id: "topic", keywords: [], representativeDocumentIds: ["b"] }],
    },
    { ...result, topics: [...result.topics, ...result.topics] },
  ])(
    "rejects invented, omitted, duplicate and incorrectly represented evidence",
    (value) =>
      expect(() =>
        validateClusteringResult(value, "run", ["a", "b"]),
      ).toThrow(),
  );
});
