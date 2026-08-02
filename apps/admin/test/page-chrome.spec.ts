import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The chrome every admin route shares: the title mark, the way out, and the
 * vertical rhythm the two sit in.
 *
 * These are source-text assertions on purpose. The thing that went wrong here
 * was not a broken render — every screen worked. It was drift: four back links
 * with three glyphs and two grammars, the same six marker utilities pasted into
 * three files, and five different gaps under the title. Nothing but reading the
 * sources together catches that, so that is what this file does.
 */
function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const globalsCss = readAdminFile("src/styles/globals.css");
const backLink = readAdminFile("src/components/ui/JtsBackLink.tsx");
const pageHeader = readAdminFile("src/components/ui/JtsPageHeader.tsx");

/**
 * Routes whose content flows down the page, and the component each one's root
 * element opens with. These all start on the same gap, so the space under the
 * title is the same wherever the operator lands.
 */
const FLOWING_ROUTES = [
  ["src/routes/OverviewPage.tsx", "<JtsPageHeader"],
  ["src/routes/EventsPage.tsx", "<JtsPageHeader"],
  ["src/routes/EventDetailPage.tsx", "<JtsPageHeader"],
  ["src/routes/ParticipantsPage.tsx", "<JtsPageHeader"],
  ["src/routes/ParticipantProfilePage.tsx", "<BackToParticipantsLink />"],
  ["src/routes/FeedbackCampaignsPage.tsx", "<JtsPageHeader"],
  ["src/routes/FeedbackInboxPage.tsx", "<CampaignHeader"],
  ["src/routes/FeedbackMechanismPage.tsx", "<JtsPageHeader"],
  ["src/routes/FeedbackResultsPage.tsx", "<JtsPageHeader"],
] as const;

/**
 * Routes that fill the viewport instead of flowing. Their panes, not the page,
 * set the vertical rhythm — a fixed page gap there is height taken straight out
 * of the work — so they own their gap and only have to keep the height grammar
 * that makes the panes scroll rather than the document.
 *
 * `AssistantPage` is in neither list: it is a full-height chat surface with a
 * screen-reader-only h1 and no page header at all.
 */
const FULL_HEIGHT_ROUTES = ["src/routes/FeedbackOutboxPage.tsx"];

/** Every route that shows a page header, however it spends its height. */
const ADMIN_ROUTES = [
  ...FLOWING_ROUTES,
  ...FULL_HEIGHT_ROUTES.map((path) => [path, "<JtsPageHeader"] as const),
] as const;

/** Every file that renders a route's own h1, however it composes the rest. */
const TITLE_OWNERS = [
  "src/components/ui/JtsPageHeader.tsx",
  "src/components/admin/feedback/CampaignHeader.tsx",
  "src/routes/ParticipantProfilePage.tsx",
];

describe("the six-dot title mark", () => {
  it("is one utility in globals.css, not a class string screens copy", () => {
    expect(globalsCss).toContain("@utility jts-title-mark");

    // The dash it replaced: 3px tall, 2rem wide, painted by six Tailwind
    // `after:` utilities that three files each carried a copy of.
    for (const path of [
      ...TITLE_OWNERS,
      "src/routes/CookbookPage.tsx",
      "src/styles/globals.css",
    ]) {
      expect(readAdminFile(path)).not.toContain("after:h-[3px]");
    }
  });

  it("counts to six, and gives the last dot the copper accent", () => {
    const mark = globalsCss.slice(
      globalsCss.indexOf("@utility jts-title-mark"),
      globalsCss.indexOf("@utility jts-overline"),
    );
    const dots = mark.match(/radial-gradient\(/g) ?? [];

    // Six, because that is the product's name and the lockup's own count:
    // five at the table and a seat still open.
    expect(dots).toHaveLength(6);
    expect(mark.match(/var\(--jts-color-primary\)/g)).toHaveLength(5);
    expect(mark).toContain("var(--jts-color-accent)");
    // The accent belongs to the last dot, not a middle one.
    expect(mark.lastIndexOf("var(--jts-color-accent)")).toBeGreaterThan(
      mark.lastIndexOf("var(--jts-color-primary)"),
    );

    // A title mark is not a status: the contract forbids pulsing and glowing,
    // and a mark that breathed would be claiming something happened.
    expect(mark).not.toContain("animation");
    expect(mark).not.toContain("box-shadow");
  });

  it("is what every route-owned h1 wears", () => {
    for (const path of TITLE_OWNERS) {
      const source = readAdminFile(path);
      const title = source.slice(source.indexOf("<h1"));
      expect(title.slice(0, title.indexOf(">"))).toContain("jts-title-mark");
    }
  });
});

describe("the back affordance", () => {
  it("is JtsBackLink, and no route builds a second one", () => {
    expect(backLink).toContain("<ChevronLeft");
    expect(backLink).toContain("text-primary");

    // A back link is a chevron and a destination. An arrow, a bare word or a
    // hand-written class string is a fifth pattern for the operator to learn.
    for (const [path] of ADMIN_ROUTES) {
      const source = readAdminFile(path);
      expect(source).not.toContain("ArrowLeft");
      expect(source).not.toContain("ChevronLeft");
    }
    expect(
      readAdminFile("src/components/admin/feedback/CampaignHeader.tsx"),
    ).not.toContain("ChevronLeft");
  });

  it("says «Back to <place>» on every screen that has one", () => {
    const labels = [
      ["src/routes/EventDetailPage.tsx", 'label: "Back to events"'],
      [
        "src/routes/ParticipantProfilePage.tsx",
        '<JtsBackLink to="/admin/participants">Back to participants',
      ],
      ["src/routes/FeedbackOutboxPage.tsx", 'label: "Back to campaigns"'],
      ["src/routes/FeedbackResultsPage.tsx", 'label: "Back to conversations"'],
      [
        "src/components/admin/feedback/CampaignHeader.tsx",
        '<JtsBackLink to="/admin/feedback">Back to campaigns',
      ],
    ] as const;

    for (const [path, label] of labels) {
      expect(readAdminFile(path)).toContain(label);
    }
  });

  it("stands above the title, never inside the actions row", () => {
    // The header decides the order once. A screen that filed its exit under
    // `actions` put a navigation link among the buttons that act on the page.
    const back = pageHeader.indexOf("<JtsBackLink");
    expect(back).toBeGreaterThan(-1);
    expect(back).toBeLessThan(pageHeader.indexOf("{eyebrow"));
    expect(back).toBeLessThan(pageHeader.indexOf("<h1"));
    expect(back).toBeLessThan(pageHeader.indexOf("{actions"));

    for (const [path] of ADMIN_ROUTES) {
      expect(readAdminFile(path)).not.toMatch(/actions=\{[\s\S]{0,80}Back to /);
    }
  });
});

describe("the disclosure animation", () => {
  const disclosure = globalsCss.slice(
    globalsCss.indexOf("A <details> that opens instead of appearing"),
    globalsCss.indexOf("The one static environment indicator"),
  );
  // The comments here quote the declarations they explain, so ordering
  // assertions have to read the rules alone.
  const rules = disclosure.replace(/\/\*[\s\S]*?\*\//g, "");

  it("animates the UA's own content box, guarded so it cannot fold it away", () => {
    // `::details-content` is the only box that exists in both states, so it is
    // the only thing a height transition can run on.
    expect(rules).toContain(".jts-disclosure::details-content");
    expect(rules).toContain("block-size: 0;");
    expect(rules).toContain("calc-size(auto, size)");

    // The guard is load-bearing, not politeness: without it a browser that
    // cannot parse `calc-size` keeps the `block-size: 0` and the content is
    // gone for good rather than merely un-animated. So both declarations have
    // to sit *inside* it, not merely somewhere in the same file.
    const guard = rules.indexOf(
      "@supports (block-size: calc-size(auto, size))",
    );
    expect(guard).toBeGreaterThan(-1);
    const guarded = rules.slice(
      guard,
      rules.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(guarded).toContain("block-size: 0;");
    expect(guarded).toContain("block-size: calc-size(auto, size);");
  });

  it("spends the shared duration and easing, not a hand-picked pair", () => {
    expect(rules).toContain("var(--jts-duration-base)");
    expect(rules).toContain("var(--jts-ease-standard)");
  });

  it("names reduced motion again, because the base rule cannot reach it", () => {
    // globals.css collapses motion on `*`, `::before` and `::after`.
    // `::details-content` is none of those, so the preference has to be
    // honoured here or this is the one animation that ignores it.
    const reduced = rules.slice(
      rules.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(reduced).toContain(".jts-disclosure::details-content");
    expect(reduced).toContain("transition: none");
  });

  it("is only worn by disclosures whose body carries its own padding", () => {
    // `overflow: hidden` clips the body mid-slide, and it clips a focus ring
    // sitting flush against the content box with it. These two bodies have
    // padding; `VenueGoogleSelection`'s Place ID body does not and is left
    // native on purpose.
    const wearers = [
      "src/components/admin/feedback/CampaignSummary.tsx",
      "src/components/admin/feedback/OutboxMessageDetails.tsx",
    ];
    for (const path of wearers) {
      expect(readAdminFile(path)).toContain("jts-disclosure");
    }
    expect(
      readAdminFile("src/components/admin/events/VenueGoogleSelection.tsx"),
    ).not.toContain("jts-disclosure");
  });
});

describe("page rhythm", () => {
  it("opens every flowing route on the same gap", () => {
    for (const [path, opener] of FLOWING_ROUTES) {
      const source = readAdminFile(path);
      expect(source).toContain(
        `<div className="flex flex-col gap-6">\n      ${opener}`,
      );
    }
  });

  it("lets a full-height route own its gap, but not its height grammar", () => {
    for (const path of FULL_HEIGHT_ROUTES) {
      const source = readAdminFile(path);
      const root = source.slice(source.indexOf("  return (\n    <div"));
      const openingTag = root.slice(0, root.indexOf(">"));

      // `h-full min-h-0` is what makes the panes scroll instead of the
      // document. Without the min-h-0 a flex child refuses to shrink and the
      // whole page grows a scrollbar, which is the bug this shape exists to
      // avoid — so it is checked even though the gap is free.
      expect(openingTag).toContain("h-full");
      expect(openingTag).toContain("min-h-0");
      expect(openingTag).toContain("flex-col");
      // It still opens on the shared header, gap or no gap.
      expect(source).toContain("<JtsPageHeader");
    }
  });
});
