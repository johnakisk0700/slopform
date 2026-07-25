import type { AppTransaction, EventRow } from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { PostEventFeedbackRepository } from "../post-event-feedback/post-event-feedback.repository.js";
import type { EventsRepository } from "./events.repository.js";
import {
  EventMutationNotAllowedError,
  EventNotFoundError,
  EventStatusTransitionError,
  EventsService,
} from "./events.service.js";

const event: EventRow = {
  id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  title: "Friday dinner",
  startsAt: new Date("2026-08-01T18:00:00.000Z"),
  status: "draft",
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
};

function createService(options?: {
  readonly status?: EventRow["status"];
  readonly found?: boolean;
}): {
  readonly auditAppend: ReturnType<typeof vi.fn>;
  readonly service: EventsService;
  readonly transaction: AppTransaction;
  readonly repository: {
    findByIdForUpdate: ReturnType<typeof vi.fn>;
    transitionStatus: ReturnType<typeof vi.fn>;
    summarize: ReturnType<typeof vi.fn>;
    listPresentAttendeeCandidates: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    listAttendees: ReturnType<typeof vi.fn>;
  };
  readonly feedback: {
    findCampaignByEventId: ReturnType<typeof vi.fn>;
  };
} {
  const transaction = {} as AppTransaction;
  const current = {
    ...event,
    status: options?.status ?? "draft",
  };
  const findByIdForUpdate = vi
    .fn()
    .mockResolvedValue(options?.found === false ? undefined : current);
  const transitionStatus = vi
    .fn()
    .mockImplementation(
      async (_tx: AppTransaction, _id: string, status: EventRow["status"]) => ({
        ...current,
        status,
        updatedAt: new Date("2026-07-25T01:00:00.000Z"),
      }),
    );
  const summarize = vi.fn().mockImplementation(async () => {
    const latest = transitionStatus.mock.calls.at(-1)?.[2] as
      EventRow["status"] | undefined;
    return {
      ...current,
      status: latest ?? current.status,
      attendeeCount: 0,
      presentCount: 0,
      updatedAt: new Date("2026-07-25T01:00:00.000Z"),
    };
  });
  const repository = {
    findByIdForUpdate,
    transitionStatus,
    summarize,
    listPresentAttendeeCandidates: vi.fn().mockResolvedValue([
      {
        participantId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        displayName: "Roula",
        present: true,
      },
      {
        participantId: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        displayName: "Kostas",
        present: true,
      },
      {
        participantId: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        displayName: "Absent",
        present: false,
      },
    ]),
    findById: vi
      .fn()
      .mockResolvedValue(options?.found === false ? undefined : current),
    create: vi.fn(),
    update: vi.fn(),
    listSummaries: vi.fn(),
    listAttendees: vi.fn().mockResolvedValue([]),
    findAttendeeById: vi.fn(),
    findAttendeeByParticipant: vi.fn(),
    insertAttendee: vi.fn(),
    updateAttendee: vi.fn(),
    participantExists: vi.fn(),
  };
  const feedback = {
    findCampaignByEventId: vi.fn().mockResolvedValue(undefined),
  };
  const auditAppend = vi.fn().mockResolvedValue(undefined);
  const database = {
    transaction: vi.fn(
      async <T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> =>
        work(transaction),
    ),
  } as unknown as DatabaseService;

  return {
    auditAppend,
    repository,
    feedback,
    service: new EventsService(
      database,
      repository as unknown as EventsRepository,
      { append: auditAppend } as unknown as AuditRepository,
      feedback as unknown as PostEventFeedbackRepository,
    ),
    transaction,
  };
}

describe("EventsService status transitions", () => {
  it("allows draft → scheduled and audits the change", async () => {
    const { auditAppend, repository, service, transaction } = createService({
      status: "draft",
    });

    const view = await service.transitionStatus(
      event.id,
      { status: "scheduled" },
      "user_admin",
      "request-1",
    );

    expect(repository.transitionStatus).toHaveBeenCalledWith(
      transaction,
      event.id,
      "scheduled",
    );
    expect(auditAppend).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: "event.status_transitioned",
        context: { from: "draft", to: "scheduled" },
      }),
    );
    expect(view.status).toBe("scheduled");
  });

  it("allows scheduled → finished or cancelled", async () => {
    const finished = createService({ status: "scheduled" });
    await expect(
      finished.service.transitionStatus(
        event.id,
        { status: "finished" },
        "user_admin",
        "request-2",
      ),
    ).resolves.toMatchObject({ status: "finished" });

    const cancelled = createService({ status: "scheduled" });
    await expect(
      cancelled.service.transitionStatus(
        event.id,
        { status: "cancelled" },
        "user_admin",
        "request-3",
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects illegal transitions from finished", async () => {
    const { service } = createService({ status: "finished" });

    await expect(
      service.transitionStatus(
        event.id,
        { status: "draft" },
        "user_admin",
        "request-4",
      ),
    ).rejects.toBeInstanceOf(EventStatusTransitionError);
  });

  it("rejects draft → finished without scheduling", async () => {
    const { service } = createService({ status: "draft" });

    await expect(
      service.transitionStatus(
        event.id,
        { status: "finished" },
        "user_admin",
        "request-5",
      ),
    ).rejects.toBeInstanceOf(EventStatusTransitionError);
  });
});

describe("EventsService feedback candidates", () => {
  it("returns the shared D16 selection for a respondent", async () => {
    const { service } = createService();

    await expect(
      service.listFeedbackCandidatesForRespondent(
        event.id,
        "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      ),
    ).resolves.toEqual({
      items: [
        {
          participantId: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          displayName: "Kostas",
        },
      ],
    });
  });

  it("reports missing events", async () => {
    const { service } = createService({ found: false });

    await expect(
      service.listFeedbackCandidatesForRespondent(
        event.id,
        "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      ),
    ).rejects.toBeInstanceOf(EventNotFoundError);
  });
});

describe("EventsService edit guards", () => {
  it("blocks title edits on finished events", async () => {
    const { service } = createService({ status: "finished" });

    await expect(
      service.update(event.id, { title: "No" }, "user_admin", "request-6"),
    ).rejects.toBeInstanceOf(EventMutationNotAllowedError);
  });
});

describe("EventsService detail read model", () => {
  it("exposes a nullable feedbackCampaignId for inbox deep-links", async () => {
    const withoutCampaign = createService();
    await expect(withoutCampaign.service.get(event.id)).resolves.toMatchObject({
      id: event.id,
      feedbackCampaignId: null,
      attendees: [],
    });

    const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
    const withCampaign = createService();
    withCampaign.feedback.findCampaignByEventId.mockResolvedValue({
      id: campaignId,
    });

    await expect(withCampaign.service.get(event.id)).resolves.toMatchObject({
      feedbackCampaignId: campaignId,
    });
  });
});
