import type { AppTransaction } from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import { currentDatabaseTime } from "./database-time.js";

describe("currentDatabaseTime", () => {
  it("normalizes the raw timestamp string returned by Drizzle", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ now: "2026-08-04 07:31:20.885735+00" }],
    });

    const result = await currentDatabaseTime({
      execute,
    } as unknown as AppTransaction);

    expect(result).toEqual(new Date("2026-08-04T07:31:20.885Z"));
  });
});
