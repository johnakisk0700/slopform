import type { AppTransaction, EventRow } from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { FeedbackCampaignRepository } from "../post-event-feedback/campaign/campaign.repository.js";
import type { EventsRepository, EventVenueWrite } from "./events.repository.js";
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
  venueProvider: null,
  venuePlaceId: null,
  venueLabel: null,
  venueType: null,
  venueArea: null,
  venuePriceLevel: null,
  venuePriceStartMinor: null,
  venuePriceEndMinor: null,
  venuePriceCurrencyCode: null,
  venueUseInFeedback: null,
  venueContextRevision: 0,
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
};

const venueInput = {
  provider: "google" as const,
  placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
  label: "Six Tables Athens",
  type: "restaurant",
  area: "Pangrati",
  priceLevel: "moderate" as const,
  priceRange: {
    startMinor: 1_800,
    endMinor: 2_600,
    currencyCode: "EUR",
  },
  useInFeedback: true,
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
    findByIdForShare: ReturnType<typeof vi.fn>;
    transitionStatus: ReturnType<typeof vi.fn>;
    summarize: ReturnType<typeof vi.fn>;
    listPresentAttendeeCandidates: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    listAttendees: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  readonly feedback: {
    findCampaignByEventId: ReturnType<typeof vi.fn>;
  };
} {
  const transaction = {} as AppTransaction;
  let persisted: EventRow = {
    ...event,
    status: options?.status ?? "draft",
  };
  const findByIdForUpdate = vi
    .fn()
    .mockImplementation(async () =>
      options?.found === false ? undefined : persisted,
    );
  const transitionStatus = vi
    .fn()
    .mockImplementation(
      async (_tx: AppTransaction, _id: string, status: EventRow["status"]) => {
        persisted = {
          ...persisted,
          status,
          updatedAt: new Date("2026-07-25T01:00:00.000Z"),
        };
        return persisted;
      },
    );
  const create = vi
    .fn()
    .mockImplementation(
      async (
        _tx: AppTransaction,
        input: Parameters<EventsRepository["create"]>[1],
      ) => {
        persisted = {
          ...event,
          title: input.title,
          startsAt: input.startsAt,
          ...(input.venue
            ? venueColumns(input.venue, 1)
            : venueColumns(null, 0)),
        };
        return persisted;
      },
    );
  const update = vi
    .fn()
    .mockImplementation(
      async (
        _tx: AppTransaction,
        _id: string,
        input: Parameters<EventsRepository["update"]>[2],
      ) => {
        persisted = {
          ...persisted,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
          ...(input.venue !== undefined
            ? venueColumns(input.venue, persisted.venueContextRevision + 1)
            : {}),
          updatedAt: new Date("2026-07-25T01:00:00.000Z"),
        };
        return persisted;
      },
    );
  const summarize = vi.fn().mockImplementation(async () => ({
    ...persisted,
    attendeeCount: 0,
    presentCount: 0,
    updatedAt: new Date("2026-07-25T01:00:00.000Z"),
  }));
  const repository = {
    findByIdForUpdate,
    findByIdForShare: vi
      .fn()
      .mockImplementation(async () =>
        options?.found === false ? undefined : persisted,
      ),
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
      .mockImplementation(async () =>
        options?.found === false ? undefined : persisted,
      ),
    create,
    update,
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
      feedback as unknown as FeedbackCampaignRepository,
    ),
    transaction,
  };
}

function venueColumns(
  venue: EventVenueWrite | null,
  venueContextRevision: number,
): Pick<
  EventRow,
  | "venueProvider"
  | "venuePlaceId"
  | "venueLabel"
  | "venueType"
  | "venueArea"
  | "venuePriceLevel"
  | "venuePriceStartMinor"
  | "venuePriceEndMinor"
  | "venuePriceCurrencyCode"
  | "venueUseInFeedback"
  | "venueContextRevision"
> {
  return {
    venueProvider: venue?.provider ?? null,
    venuePlaceId: venue?.placeId ?? null,
    venueLabel: venue?.label ?? null,
    venueType: venue?.type ?? null,
    venueArea: venue?.area ?? null,
    venuePriceLevel: venue?.priceLevel ?? null,
    venuePriceStartMinor: venue?.priceStartMinor ?? null,
    venuePriceEndMinor: venue?.priceEndMinor ?? null,
    venuePriceCurrencyCode: venue?.priceCurrencyCode ?? null,
    venueUseInFeedback: venue?.useInFeedback ?? null,
    venueContextRevision,
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

  it("blocks venue edits on cancelled events", async () => {
    const { repository, service } = createService({ status: "cancelled" });

    await expect(
      service.update(
        event.id,
        { venue: venueInput },
        "user_admin",
        "request-7",
      ),
    ).rejects.toBeInstanceOf(EventMutationNotAllowedError);
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe("EventsService venue contract", () => {
  it("creates a venue at revision one without logging venue text", async () => {
    const { auditAppend, repository, service, transaction } = createService();

    const view = await service.create(
      {
        title: "Friday dinner",
        startsAt: "2026-08-01T18:00:00.000Z",
        venue: venueInput,
      },
      "user_admin",
      "request-venue-create",
    );

    expect(repository.create).toHaveBeenCalledWith(transaction, {
      title: "Friday dinner",
      startsAt: new Date("2026-08-01T18:00:00.000Z"),
      venue: {
        provider: "google",
        placeId: venueInput.placeId,
        label: venueInput.label,
        type: "restaurant",
        area: "Pangrati",
        priceLevel: "moderate",
        priceStartMinor: 1_800,
        priceEndMinor: 2_600,
        priceCurrencyCode: "EUR",
        useInFeedback: true,
      },
    });
    expect(view.venue).toEqual({ ...venueInput, contextRevision: 1 });
    expect(auditAppend).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: "event.created",
        context: {
          status: "draft",
          venueConfigured: true,
          venueContextRevision: 1,
          venueUseInFeedback: true,
        },
      }),
    );
    expect(JSON.stringify(auditAppend.mock.calls)).not.toContain(
      venueInput.placeId,
    );
    expect(JSON.stringify(auditAppend.mock.calls)).not.toContain(
      venueInput.label,
    );
  });

  it("preserves the venue revision when a draft title-only update omits venue", async () => {
    const { repository, service } = createService();
    await service.create(
      {
        title: "Friday dinner",
        startsAt: "2026-08-01T18:00:00.000Z",
        venue: venueInput,
      },
      "user_admin",
      "request-venue-seed",
    );

    const view = await service.update(
      event.id,
      { title: "Saturday dinner" },
      "user_admin",
      "request-title-only",
    );

    expect(repository.update).toHaveBeenLastCalledWith(
      expect.anything(),
      event.id,
      { title: "Saturday dinner" },
    );
    expect(view.venue?.contextRevision).toBe(1);
  });

  it("allows venue-only replacement, clear, and re-add on a finished event without resetting the revision", async () => {
    const { auditAppend, service } = createService();
    await service.create(
      {
        title: "Friday dinner",
        startsAt: "2026-08-01T18:00:00.000Z",
        venue: venueInput,
      },
      "user_admin",
      "request-venue-seed",
    );
    await service.transitionStatus(
      event.id,
      { status: "scheduled" },
      "user_admin",
      "request-schedule",
    );
    await service.transitionStatus(
      event.id,
      { status: "finished" },
      "user_admin",
      "request-finish",
    );

    const replaced = await service.update(
      event.id,
      {
        venue: {
          ...venueInput,
          label: "Six Tables Athens — confirmed",
          useInFeedback: false,
        },
      },
      "user_admin",
      "request-venue-replace",
    );
    const cleared = await service.update(
      event.id,
      { venue: null },
      "user_admin",
      "request-venue-clear",
    );
    const readded = await service.update(
      event.id,
      { venue: venueInput },
      "user_admin",
      "request-venue-readd",
    );

    expect(replaced.venue?.contextRevision).toBe(2);
    expect(cleared.venue).toBeNull();
    expect(readded.venue?.contextRevision).toBe(4);
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "event.updated",
        requestId: "request-venue-clear",
        context: expect.objectContaining({
          venueChanged: true,
          venueConfigured: false,
          venueContextRevision: 3,
        }),
      }),
    );
  });

  it("publishes only enabled provider-free context and fences its revision under a shared lock", async () => {
    const { repository, service, transaction } = createService();
    await service.create(
      {
        title: "Friday dinner",
        startsAt: "2026-08-01T18:00:00.000Z",
        venue: venueInput,
      },
      "user_admin",
      "request-venue-seed",
    );

    await expect(service.getFeedbackVenueContext(event.id)).resolves.toEqual({
      contextRevision: 1,
      venue: {
        label: venueInput.label,
        type: venueInput.type,
        area: venueInput.area,
        priceLevel: venueInput.priceLevel,
        priceRange: venueInput.priceRange,
      },
    });
    await expect(
      service.feedbackVenueContextIsCurrent(transaction, event.id, 1),
    ).resolves.toBe(true);
    expect(repository.findByIdForShare).toHaveBeenCalledWith(
      transaction,
      event.id,
    );

    await service.update(
      event.id,
      { venue: { ...venueInput, useInFeedback: false } },
      "user_admin",
      "request-disable-feedback-context",
    );
    await expect(service.getFeedbackVenueContext(event.id)).resolves.toEqual({
      contextRevision: 2,
      venue: null,
    });
    await expect(
      service.feedbackVenueContextIsCurrent(transaction, event.id, 1),
    ).resolves.toBe(false);
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
