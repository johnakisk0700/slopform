import { describe, expect, it } from "vitest";

import {
  decodeOutboxHistoryCursor,
  encodeOutboxHistoryCursor,
} from "./history-cursor.js";

const CREATED_AT = new Date("2026-07-27T11:41:00.500Z");
const ID = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";

describe("outbox history cursor", () => {
  it("round-trips the sort key it was cut from", () => {
    const cursor = encodeOutboxHistoryCursor({ createdAt: CREATED_AT, id: ID });

    expect(decodeOutboxHistoryCursor(cursor)).toEqual({
      createdAt: CREATED_AT,
      id: ID,
    });
  });

  it("keeps the millisecond, because the sort key does", () => {
    // Two messages written inside the same second is the ordinary case during
    // a burst. A cursor rounded to the second would either repeat that whole
    // second on every page or skip past it.
    const cursor = encodeOutboxHistoryCursor({ createdAt: CREATED_AT, id: ID });

    expect(decodeOutboxHistoryCursor(cursor)?.createdAt.toISOString()).toBe(
      "2026-07-27T11:41:00.500Z",
    );
  });

  it("survives a query string, so it carries no + or /", () => {
    const cursors = Array.from({ length: 64 }, (_entry, index) =>
      encodeOutboxHistoryCursor({
        createdAt: new Date(CREATED_AT.getTime() + index * 977),
        id: ID,
      }),
    );

    expect(cursors.some((cursor) => /[+/=]/u.test(cursor))).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["not base64 at all", "not-a-cursor"],
    ["no separator", Buffer.from("nonsense").toString("base64url")],
    [
      "an unparseable time",
      Buffer.from(`never|${ID}`, "utf8").toString("base64url"),
    ],
    [
      "an id that is not a uuid",
      Buffer.from(`${CREATED_AT.toISOString()}|../../etc`, "utf8").toString(
        "base64url",
      ),
    ],
  ])("refuses %s rather than building a predicate from it", (_name, value) => {
    expect(decodeOutboxHistoryCursor(value)).toBeNull();
  });
});
