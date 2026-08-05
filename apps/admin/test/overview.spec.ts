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
    expect(page).toContain('size="sm"');
    expect(page).toContain('variant="secondary"');
    expect(page).toContain("actions=");
    expect(page).not.toContain("mt-5 shrink-0");
  });

  it("gives operator-queue links a hover wash", () => {
    expect(page).toContain("hover:bg-surface-sunken");
    expect(page).toContain("transition-colors");
  });

  it("surfaces real operator metrics, not bookings fiction", () => {
    expect(page).toContain("Scheduled events");
    expect(page).toContain("Needs attention");
    expect(page).toContain("Undelivered messages");
    expect(page).toContain("feedbackContactableCount");
    expect(page).not.toContain("Bookings");
    expect(page).not.toContain("capacity");
  });

  it("keeps the summary scannable as a two-by-two mobile grid", () => {
    expect(page).toContain(
      'className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"',
    );
  });
});

describe("JtsStat responsive density", () => {
  it("uses compact spacing and type below the small breakpoint", () => {
    const stat = readAdminFile("src/components/ui/JtsStat.tsx");
    expect(stat).toContain("p-4 sm:p-5");
    expect(stat).toContain("right-4 top-4 sm:right-5 sm:top-5");
    expect(stat).toContain("text-[0.6875rem]");
    expect(stat).toContain("sm:text-xs");
  });
});

describe("JtsPageHeader actions placement", () => {
  it("anchors actions to the bottom-right of the full-width header row", () => {
    const header = readAdminFile("src/components/ui/JtsPageHeader.tsx");
    expect(header).toContain(
      'className="flex w-full items-end justify-between gap-4"',
    );
    expect(header).toContain("shrink-0 flex-wrap items-center justify-end");
    expect(header).not.toContain("max-w-[58rem]");
    expect(header).not.toContain("mt-3 flex flex-wrap gap-3");
  });
});
