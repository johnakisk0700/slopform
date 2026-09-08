import { z } from "zod";

const identifier = z.string().min(1).max(128);
export const clusteringResultSchema = z
  .object({
    version: z.literal(1),
    requestId: identifier,
    type: z.literal("result"),
    topics: z
      .array(
        z
          .object({
            id: identifier,
            keywords: z.array(z.string().min(1).max(100)).max(20),
            representativeDocumentIds: z.array(identifier).min(1).max(10),
          })
          .strict(),
      )
      .max(500),
    assignments: z
      .array(
        z
          .object({ documentId: identifier, topicId: identifier.nullable() })
          .strict(),
      )
      .max(500),
  })
  .strict();
export const clusteringProgressSchema = z
  .object({
    version: z.literal(1),
    requestId: identifier,
    type: z.literal("progress"),
    stage: z.enum(["validate", "reduce", "cluster", "describe"]),
  })
  .strict();
export type ClusteringResult = z.infer<typeof clusteringResultSchema>;
export type ClusteringRequest = {
  version: 1;
  requestId: string;
  documents: { id: string; text: string; embedding: number[] }[];
  options: { minTopicSize: number; minSamples: number; randomSeed: number };
};
export class ClusteringFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ClusteringFailure";
  }
}

/** Structural validation is followed by full snapshot membership validation. */
export function validateClusteringResult(
  value: unknown,
  requestId: string,
  documentIds: string[],
): ClusteringResult {
  const parsed = clusteringResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.requestId !== requestId)
    throw new ClusteringFailure("clustering_result_invalid", false);
  const result = parsed.data;
  const expected = new Set(documentIds);
  const assigned = new Map<string, string | null>();
  const topicIds = new Set(result.topics.map((topic) => topic.id));
  if (
    expected.size !== documentIds.length ||
    topicIds.size !== result.topics.length ||
    result.assignments.length !== expected.size
  )
    throw new ClusteringFailure("clustering_coverage_invalid", false);
  for (const assignment of result.assignments) {
    if (
      !expected.has(assignment.documentId) ||
      assigned.has(assignment.documentId) ||
      (assignment.topicId !== null && !topicIds.has(assignment.topicId))
    )
      throw new ClusteringFailure("clustering_coverage_invalid", false);
    assigned.set(assignment.documentId, assignment.topicId);
  }
  for (const topic of result.topics) {
    if (
      new Set(topic.representativeDocumentIds).size !==
        topic.representativeDocumentIds.length ||
      topic.representativeDocumentIds.some(
        (id) => !expected.has(id) || assigned.get(id) !== topic.id,
      )
    )
      throw new ClusteringFailure("clustering_representatives_invalid", false);
  }
  return result;
}
