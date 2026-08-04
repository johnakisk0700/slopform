import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("OverviewPage", () => {
  const page = readAdminFile("src/routes/OverviewPage.tsx");

  it("loads exact aggregates through the generated getOverview hook", () => {
    expect(page).toContain('from "../api/generated/overview"');
    expect(page).toContain("useGetOverview");
    expect(page).toContain("overviewQuery.refetch");
    expect(page).not.toContain("Local product preview");
    expect(page).not.toContain("eventPreviewSchema");
    expect(page).not.toContain("New event");
  });

  it("keeps Refresh in the page header actions slot", () => {
    expect(page).toContain('aria-label="Refresh overview"');
    expect(page).toContain("RefreshCw");
    expect(page).toContain("actions=");
  });

  it("surfaces real operator metrics, not bookings fiction", () => {
    expect(page).toContain("Scheduled events");
    expect(page).toContain("Needs attention");
    expect(page).toContain("Undelivered messages");
    expect(page).toContain("feedbackContactableCount");
    expect(page).not.toContain("Bookings");
    expect(page).not.toContain("capacity");
  });
});

describe("JtsPageHeader actions placement", () => {
  it("anchors actions to the top-right of the header row", () => {
    const header = readAdminFile("src/components/ui/JtsPageHeader.tsx");
    expect(header).toContain(
      'className="flex w-full max-w-[58rem] items-start justify-between gap-4"',
    );
    expect(header).toContain("shrink-0 flex-wrap items-start justify-end");
    expect(header).not.toContain("mt-3 flex flex-wrap gap-3");
  });
});
