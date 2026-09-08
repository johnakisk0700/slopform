import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConfigService } from "@nestjs/config";
import {
  createDatabase,
  auditEvents,
  events,
  participants,
  feedbackCampaigns,
  feedbackNotes,
  feedbackTopicAnalyses,
  feedbackTopicAnalysisSlot,
  feedbackTopicEmbeddings,
  type DatabaseClient,
  type AppTransaction,
} from "@slopform/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { Environment } from "../../../infrastructure/config/environment.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  EmbeddingProviderFailure,
  type OpenRouterEmbeddingsClient,
} from "../../../integrations/openrouter/openrouter-embeddings.client.js";
import type { TopicClusteringClient } from "../../../integrations/topic-clustering/topic-clustering.client.js";
import type { ClusteringRequest } from "../../../integrations/topic-clustering/topic-clustering.protocol.js";
import { TopicAnalysisRepository } from "./topic-analysis.repository.js";
import {
  TopicAnalysisRunner,
  buildTopicAnalysisResult,
} from "./topic-analysis.runner.js";
import { TopicAnalysisService } from "./topic-analysis.service.js";
import type { TopicAnalysisWakeup } from "./topic-analysis.wakeup.js";
import {
  embeddingCacheIdentity,
  TopicAnalysisClaimLost,
  topicAnalysisSnapshotSchema,
} from "./topic-analysis.schemas.js";

// This opt-in suite never falls back to application DATABASE_URL.
const postgresTestUrl = process.env.FEEDBACK_POSTGRES_TEST_URL;
const postgres = postgresTestUrl ? describe : describe.skip;
postgres("Topic analysis PostgreSQL persistence", () => {
  let client: DatabaseClient;
  let database: DatabaseService;
  let repository: TopicAnalysisRepository;
  let service: TopicAnalysisService;
  let campaignId: string;
  let eventId: string;
  let respondentId: string;
  const wakeup = { publish: vi.fn().mockResolvedValue(undefined) };
  beforeAll(async () => {
    client = createDatabase({
      connectionString: postgresTestUrl!,
      applicationName: "topic-analysis-test",
      maxConnections: 5,
    });
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../../../../packages/database/drizzle", import.meta.url),
      ),
    });
    database = {
      db: client.db,
      transaction: <T>(work: (transaction: AppTransaction) => Promise<T>) =>
        client.db.transaction(work),
    } as DatabaseService;
    repository = new TopicAnalysisRepository(database);
    service = new TopicAnalysisService(
      new ConfigService<Environment, true>({
        FEEDBACK_TOPIC_ANALYSIS_ENABLED: true,
      }),
      database,
      repository,
      new AuditRepository(),
      wakeup as unknown as TopicAnalysisWakeup,
    );
  }, 30_000);
  beforeEach(async () => {
    campaignId = randomUUID();
    eventId = randomUUID();
    respondentId = randomUUID();
    await client.db.transaction(async (transaction) => {
      await transaction.insert(events).values({
        id: eventId,
        title: "Topic test",
        startsAt: new Date(),
        status: "finished",
      });
      await transaction.insert(participants).values({
        id: respondentId,
        emailNormalized: `${respondentId}@example.test`,
      });
      await transaction.insert(feedbackCampaigns).values({
        id: campaignId,
        eventId,
        questionSetVersion: 2,
        questions: { version: 2 },
        launchedAt: new Date(),
        launchedBy: "topic-test",
      });
    });
    await addNotes(1);
  });
  afterEach(async () => {
    await client.db.transaction(async (transaction) => {
      const runs = await transaction
        .select({
          id: feedbackTopicAnalyses.id,
          token: feedbackTopicAnalyses.claimToken,
        })
        .from(feedbackTopicAnalyses)
        .where(eq(feedbackTopicAnalyses.campaignId, campaignId));
      const tokens = runs.flatMap((run) => (run.token ? [run.token] : []));
      if (tokens.length)
        await transaction
          .update(feedbackTopicAnalysisSlot)
          .set({ claimToken: null, claimExpiresAt: null })
          .where(
            and(
              eq(feedbackTopicAnalysisSlot.id, 1),
              inArray(feedbackTopicAnalysisSlot.claimToken, tokens),
            ),
          );
      if (runs.length)
        await transaction.delete(auditEvents).where(
          and(
            eq(auditEvents.entityType, "feedback_topic_analysis"),
            inArray(
              auditEvents.entityId,
              runs.map((run) => run.id),
            ),
          ),
        );
      await transaction
        .delete(feedbackTopicEmbeddings)
        .where(eq(feedbackTopicEmbeddings.campaignId, campaignId));
      await transaction
        .delete(feedbackTopicAnalyses)
        .where(eq(feedbackTopicAnalyses.campaignId, campaignId));
      await transaction
        .delete(feedbackNotes)
        .where(eq(feedbackNotes.campaignId, campaignId));
      await transaction
        .delete(feedbackCampaigns)
        .where(eq(feedbackCampaigns.id, campaignId));
      await transaction.delete(events).where(eq(events.id, eventId));
      await transaction
        .delete(participants)
        .where(eq(participants.id, respondentId));
    });
  });
  afterAll(async () => {
    await client?.pool.end();
  });

  async function addNotes(count: number) {
    const salt = randomUUID();
    await client.db.insert(feedbackNotes).values(
      Array.from({ length: count }, (_, index) => ({
        campaignId,
        conversationId: randomUUID(),
        respondentParticipantId: respondentId,
        noteType: "general",
        text: `Συνθετικό σχόλιο ${salt} ${index}`,
        sourceMessageIds: [randomUUID()],
        extractionMeta: { model: "test", candidateIds: [] },
      })),
    );
  }
  async function startRun() {
    return service.start(campaignId, "user_localdev");
  }
  async function claim(id: string) {
    const acquired = await database.transaction((transaction) =>
      repository.claimRun(transaction, id),
    );
    if (acquired.kind !== "claimed")
      throw new Error(`Expected claim, got ${acquired.kind}`);
    return acquired;
  }
  async function expireClaim(id: string) {
    await database.transaction(async (transaction) => {
      const row = await repository.findById(id);
      await transaction
        .update(feedbackTopicAnalysisSlot)
        .set({ claimExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(feedbackTopicAnalysisSlot.claimToken, row!.claimToken!));
      await transaction
        .update(feedbackTopicAnalyses)
        .set({
          claimExpiresAt: sql`clock_timestamp() - interval '1 second'`,
          nextWakeupAt: sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(feedbackTopicAnalyses.id, id));
    });
  }
  const emptyTopics = (request: ClusteringRequest) => ({
    version: 1 as const,
    requestId: request.requestId,
    type: "result" as const,
    topics: [],
    assignments: request.documents.map((document) => ({
      documentId: document.id,
      topicId: null,
    })),
  });
  function resultFor(run: Awaited<ReturnType<typeof claim>>["run"]) {
    const snapshot = topicAnalysisSnapshotSchema.parse(run.snapshot);
    return buildTopicAnalysisResult(snapshot, {
      version: 1,
      requestId: run.id,
      type: "result",
      topics: [],
      assignments: snapshot.documents.map((document) => ({
        documentId: document.id,
        topicId: null,
      })),
    });
  }

  it("concurrent requests share one durable identity/audit; changed notes create an immutable new snapshot", async () => {
    const requests = await Promise.all([startRun(), startRun(), startRun()]);
    expect(new Set(requests.map((run) => run.id)).size).toBe(1);
    const id = requests[0]!.id;
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, id)),
    ).toHaveLength(1);
    await addNotes(1);
    const changed = await startRun();
    expect(changed.id).not.toBe(id);
    expect((await service.get(campaignId, id)).documentCount).toBe(1);
    expect(changed.documentCount).toBe(2);
  });
  it("serializes duplicate and deployment-wide claims; stale workers cannot complete or write cache", async () => {
    const first = await startRun();
    await addNotes(1);
    const second = await startRun();
    const concurrent = await Promise.all([
      database.transaction((tx) => repository.claimRun(tx, first.id)),
      database.transaction((tx) => repository.claimRun(tx, first.id)),
    ]);
    expect(concurrent.map((outcome) => outcome.kind).sort()).toEqual([
      "busy",
      "claimed",
    ]);
    const acquired = concurrent.find((outcome) => outcome.kind === "claimed")!;
    expect(
      await database.transaction((tx) => repository.claimRun(tx, second.id)),
    ).toEqual({ kind: "busy" });
    await expireClaim(first.id);
    const successor = await claim(first.id);
    expect(successor.claim.epoch).toBe(acquired.claim.epoch + 1);
    await expect(
      database.transaction((tx) =>
        repository.completeRun(tx, acquired.claim, resultFor(acquired.run)),
      ),
    ).rejects.toBeInstanceOf(TopicAnalysisClaimLost);
    const document = topicAnalysisSnapshotSchema.parse(acquired.run.snapshot)
      .documents[0]!;
    await expect(
      database.transaction((tx) =>
        repository.recordEmbeddingBatch(
          tx,
          acquired.claim,
          [
            {
              ...embeddingCacheIdentity(campaignId, document.text),
              campaignId,
              embedding: Array(1024).fill(1),
            },
          ],
          { promptTokens: 7, costUsd: null },
        ),
      ),
    ).rejects.toBeInstanceOf(TopicAnalysisClaimLost);
    expect(
      await client.db
        .select()
        .from(feedbackTopicEmbeddings)
        .where(eq(feedbackTopicEmbeddings.campaignId, campaignId)),
    ).toHaveLength(0);
    await database.transaction((tx) =>
      repository.completeRun(tx, successor.claim, resultFor(successor.run)),
    );
    expect(
      await database.transaction((tx) => repository.claimRun(tx, first.id)),
    ).toEqual({ kind: "terminal" });
  });
  it("rolls result and terminal status back together, then completes once", async () => {
    const started = await startRun();
    const acquired = await claim(started.id);
    await expect(
      database.transaction(async (tx) => {
        await repository.completeRun(
          tx,
          acquired.claim,
          resultFor(acquired.run),
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(await repository.findById(started.id)).toMatchObject({
      status: "running",
      result: null,
      claimToken: acquired.claim.token,
    });
    await expect(
      service.getResult(campaignId, started.id),
    ).rejects.toMatchObject({ status: 409 });
    await database.transaction((tx) =>
      repository.completeRun(tx, acquired.claim, resultFor(acquired.run)),
    );
    const result = await service.getResult(campaignId, started.id);
    expect(result.result).toMatchObject({
      documentCount: 1,
      respondentCount: 1,
      outlierRespondentCount: 1,
    });
    expect((await startRun()).id).toBe(started.id);
  });
  it("retains committed embeddings/usage through a retry and never exposes partial results", async () => {
    await addNotes(32);
    const started = await startRun();
    const embed = vi
      .fn()
      .mockImplementation(async (input: { texts: string[] }) => ({
        vectors: input.texts.map(() => Array(1024).fill(0.123456789)),
        usage: { promptTokens: 10, costUsd: 0.00001 },
      }));
    embed.mockImplementationOnce(async (input: { texts: string[] }) => ({
      vectors: input.texts.map(() => Array(1024).fill(0.123456789)),
      usage: { promptTokens: 10, costUsd: 0.00001 },
    }));
    embed.mockImplementationOnce(async () => {
      throw new EmbeddingProviderFailure("embedding_http_503", true);
    });
    const cluster = vi.fn(async (request: ClusteringRequest) => {
      expect(request.documents[0]!.embedding[0]).toBe(Math.fround(0.123456789));
      return emptyTopics(request);
    });
    const runner = new TopicAnalysisRunner(
      database,
      repository,
      { embed } as unknown as OpenRouterEmbeddingsClient,
      { cluster } as unknown as TopicClusteringClient,
    );
    await expect(runner.run(started.id)).rejects.toMatchObject({
      retryable: true,
    });
    expect(await repository.findById(started.id)).toMatchObject({
      status: "pending",
      result: null,
      attempts: 1,
      reservedRequests: 2,
      observedResponses: 1,
      observedPromptTokens: 10,
    });
    expect(cluster).not.toHaveBeenCalled();
    await expect(runner.run(started.id)).resolves.toBe("completed");
    expect(embed.mock.calls.map((call) => call[0].texts.length)).toEqual([
      32, 1, 1,
    ]);
    expect(await service.get(campaignId, started.id)).toMatchObject({
      status: "completed",
      attempts: 2,
      reservedRequests: 3,
      observedResponses: 2,
      observedPromptTokens: 20,
    });
    expect(
      (await service.getResult(campaignId, started.id)).result.respondentCount,
    ).toBe(1);
    await expect(runner.run(started.id)).resolves.toBe("terminal");
    expect(embed).toHaveBeenCalledTimes(3);
  });
  it("enforces lifetime reservation/attempt budgets even after process loss and discovers committed unqueued intent", async () => {
    const started = await startRun();
    const first = await claim(started.id);
    await database.transaction(async (tx) => {
      for (let index = 0; index < 48; index++)
        expect(
          await repository.reserveEmbeddingRequest(tx, first.claim, 1),
        ).toBe(true);
      expect(await repository.reserveEmbeddingRequest(tx, first.claim, 1)).toBe(
        false,
      );
    });
    await expireClaim(started.id);
    const due = await database.transaction((tx) =>
      repository.allocateDueWakeups(tx),
    );
    expect(due.map((run) => run.id)).toContain(started.id);
    const second = await claim(started.id);
    await expireClaim(started.id);
    const third = await claim(started.id);
    await expireClaim(started.id);
    expect(second.claim.attempts).toBe(2);
    expect(third.claim.attempts).toBe(3);
    expect(
      await database.transaction((tx) => repository.claimRun(tx, started.id)),
    ).toEqual({ kind: "terminal" });
    expect(await service.get(campaignId, started.id)).toMatchObject({
      status: "failed",
      errorCode: "attempts_exhausted",
      reservedRequests: 48,
    });
  });
});
