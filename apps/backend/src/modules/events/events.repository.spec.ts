import type { AppTransaction, EventRow } from "@slopform/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { EventsRepository, type EventVenueWrite } from "./events.repository.js";

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

const venue: EventVenueWrite = {
  provider: "google",
  placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
  label: "Six Tables Athens",
  type: "restaurant",
  area: "Pangrati",
  priceLevel: "moderate",
  priceStartMinor: 1_800,
  priceEndMinor: 2_600,
  priceCurrencyCode: "EUR",
  useInFeedback: true,
};

function createRepositoryDouble(): {
  repository: EventsRepository;
  transaction: AppTransaction;
  insertValues: ReturnType<typeof vi.fn>;
  updateSet: ReturnType<typeof vi.fn>;
  lockFor: ReturnType<typeof vi.fn>;
} {
  const returning = vi.fn().mockResolvedValue([event]);
  const insertValues = vi.fn().mockReturnValue({ returning });
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning }),
  });
  const lockFor = vi.fn().mockResolvedValue([event]);
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ for: lockFor }),
      }),
    }),
  });
  const transaction = {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    select,
  } as unknown as AppTransaction;

  return {
    repository: new EventsRepository({} as DatabaseService),
    transaction,
    insertValues,
    updateSet,
    lockFor,
  };
}

describe("EventsRepository venue writes", () => {
  it("starts a created venue at revision one", async () => {
    const { insertValues, repository, transaction } = createRepositoryDouble();

    await repository.create(transaction, {
      title: event.title,
      startsAt: event.startsAt,
      venue,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        venueProvider: "google",
        venuePlaceId: venue.placeId,
        venueContextRevision: 1,
      }),
    );
  });

  it("atomically increments revision for every explicit clear", async () => {
    const { repository, transaction, updateSet } = createRepositoryDouble();

    await repository.update(transaction, event.id, { venue: null });

    const mutation = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mutation).toMatchObject({
      venueProvider: null,
      venuePlaceId: null,
      venueLabel: null,
      venueUseInFeedback: null,
    });
    const revisionSql = new PgDialect().sqlToQuery(
      mutation.venueContextRevision as SQL,
    ).sql;
    expect(revisionSql).toContain('"events"."venue_context_revision" + 1');
  });

  it("does not touch venue columns when the patch omits venue", async () => {
    const { repository, transaction, updateSet } = createRepositoryDouble();

    await repository.update(transaction, event.id, { title: "New title" });

    const mutation = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mutation).not.toHaveProperty("venueProvider");
    expect(mutation).not.toHaveProperty("venueContextRevision");
  });

  it("uses a shared event-row lock for the feedback context fence", async () => {
    const { lockFor, repository, transaction } = createRepositoryDouble();

    await expect(
      repository.findByIdForShare(transaction, event.id),
    ).resolves.toEqual(event);
    expect(lockFor).toHaveBeenCalledWith("share");
  });
});
