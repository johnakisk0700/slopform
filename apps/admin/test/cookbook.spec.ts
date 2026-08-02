import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The cookbook is the panel's audit surface for a token or bridge change, so
 * the facts it rests on are the ones worth locking: that it never reaches a
 * production build, that it owns no colour of its own, and that its specimens
 * are the real components rather than copies that can drift.
 */
function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const app = readAdminFile("src/App.tsx");
const navigation = readAdminFile("src/components/admin/AdminNavigation.tsx");
const cookbook = readAdminFile("src/routes/CookbookPage.tsx");
const outboxDetails = readAdminFile(
  "src/components/admin/feedback/OutboxMessageDetails.tsx",
);
const tokensCss = readFileSync(
  fileURLToPath(
    new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url),
  ),
  "utf8",
);

describe("cookbook gating", () => {
  it("binds the lazy chunk to import.meta.env.DEV so production drops it", () => {
    expect(app).toMatch(/const CookbookPage = import\.meta\.env\.DEV/);
    expect(app).toContain('import("./routes/CookbookPage")');

    // The only dynamic import of the module must sit inside the DEV branch —
    // a second, ungated one would put the chunk back into the build.
    const devBranch = app.slice(
      app.indexOf("const CookbookPage = import.meta.env.DEV"),
      app.indexOf("function LazyAdminRoute"),
    );
    expect(devBranch).toContain('import("./routes/CookbookPage")');
    expect(app.match(/import\("\.\/routes\/CookbookPage"\)/g)).toHaveLength(1);
  });

  it("registers /admin/cookbook only when that gate produced a component", () => {
    expect(app).toContain("{CookbookPage ? (");
    expect(app).toContain('path="cookbook"');
  });

  it("gates the navigation row on the same literal", () => {
    expect(navigation).toMatch(
      /const DEV_NAV_ITEMS: readonly NavItem\[\] = import\.meta\.env\.DEV/,
    );
    expect(navigation).toContain('to: "/admin/cookbook"');
    // The production arm is an empty list, so the row, the divider and the
    // label all disappear with it rather than rendering an empty group.
    expect(navigation).toMatch(
      /import\.meta\.env\.DEV\s*\?[\s\S]*?\n\s*: \[\];/,
    );
    expect(navigation).toContain("DEV_NAV_ITEMS.length > 0");
  });

  it("keeps the cookbook out of the numbered product areas", () => {
    const productList = navigation.slice(
      navigation.indexOf("const NAV_ITEMS"),
      navigation.indexOf("const DEV_NAV_ITEMS"),
    );
    expect(productList).not.toContain("cookbook");
  });
});

describe("cookbook house style", () => {
  it("writes no literal colour value", () => {
    expect(cookbook).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(cookbook).not.toContain("rgb(");
    expect(cookbook).not.toContain("oklch(");
    expect(cookbook).not.toContain("hsl(");
  });

  it("writes no default Tailwind palette class", () => {
    expect(cookbook).not.toMatch(
      /(bg|text|border)-(red|blue|slate|gray|grey|zinc|neutral|stone|amber|emerald|green|indigo|violet|purple|sky|cyan|teal|orange|rose|pink|yellow|lime|fuchsia)-[0-9]/,
    );
  });

  it("paints every swatch with the utility it names", () => {
    const swatches = [
      ...cookbook.matchAll(
        /utility:\s*"([^"]+)",\s*token:\s*"([^"]+)",\s*chip:\s*"([^"]+)"/g,
      ),
    ];

    // Guards the guard: a formatting change that stopped this matching would
    // otherwise leave the assertion below passing over an empty list.
    expect(swatches.length).toBeGreaterThan(20);
    for (const [, utility = "", , chip = ""] of swatches) {
      expect(chip.split(" ")).toContain(utility);
    }
  });

  it("names only tokens that exist in the single source of truth", () => {
    const defined = new Set(
      [...tokensCss.matchAll(/(--jts-[\w-]+):/g)].map(([, name]) => name),
    );
    const referenced = new Set(
      [...cookbook.matchAll(/--jts-[\w-]+/g)].map(([name]) => name),
    );

    expect(referenced.size).toBeGreaterThan(40);
    for (const token of referenced) {
      expect(defined).toContain(token);
    }
  });

  it("renders with the backend down — no query, no fetch, no client", () => {
    expect(cookbook).not.toContain("api/generated");
    expect(cookbook).not.toContain("useQuery");
    expect(cookbook).not.toContain("fetch(");
  });

  it("keeps the page's single h1 by hiding the JtsPageHeader specimen", () => {
    const specimen = cookbook.slice(
      cookbook.indexOf("JtsPageHeader — specimen frame"),
    );
    // The specimen is the real component, so the h1 it renders has to leave the
    // accessibility tree instead of being faked at another level.
    expect(specimen.indexOf('aria-hidden="true"')).toBeLessThan(
      specimen.indexOf("<JtsPageHeader"),
    );
  });
});

describe("cookbook specimen sources", () => {
  it("reuses the outbox pane's own pill, bar and class instead of copying them", () => {
    expect(outboxDetails).toContain("export const FACT_PILL");
    expect(outboxDetails).toContain("export function TimestampPill");
    expect(outboxDetails).toContain("export function ConfidenceValue");

    expect(cookbook).toContain(
      '} from "../components/admin/feedback/OutboxMessageDetails";',
    );
    // A cookbook that redeclares the markup it documents is worse than none.
    expect(cookbook).not.toMatch(/const FACT_PILL\s*=/);
    expect(cookbook).not.toMatch(/function (TimestampPill|ConfidenceValue)/);
  });

  it("shows every shared Jts contract", () => {
    for (const component of [
      "JtsPageHeader",
      "JtsBackLink",
      "JtsStat",
      "JtsDataTable",
      "JtsLiveIndicator",
    ]) {
      expect(cookbook).toContain(`<${component}`);
    }
  });

  it("shows every feedback badge tone in both emphases", () => {
    for (const tone of [
      "neutral",
      "info",
      "success",
      "warning",
      "danger",
      "accent",
    ]) {
      expect(cookbook).toContain(`tone: "${tone}"`);
    }
    expect(cookbook).toContain('emphasis: "strong"');
    expect(cookbook).toContain("<FeedbackBadges");
    expect(cookbook).toContain("<CopyableId");
    expect(cookbook).toContain("<ProviderMark");
  });

  it("renders live HeroUI components rather than mockups of them", () => {
    for (const component of [
      "Button",
      "Chip",
      "Input",
      "TextArea",
      "Select",
      "Slider",
      "Pagination",
      "Avatar",
      "Popover",
      "Modal",
      "Drawer",
      "Table",
      "ListBox",
      "ScrollShadow",
    ]) {
      expect(cookbook).toContain(`<${component}`);
    }
    expect(cookbook).toContain("toast.success(");
  });

  it("builds the table of contents and the sections from one list", () => {
    const ids = [...cookbook.matchAll(/^ {2}id: "([\w-]+)",$/gm)].map(
      ([, id]) => id,
    );

    expect(ids).toEqual([
      "colour",
      "type",
      "heroui",
      "jts",
      "feedback",
      "motifs",
    ]);
    expect(cookbook).toContain("const SECTIONS: readonly SectionSpec[]");
    for (const id of ids) {
      expect(cookbook).toContain(`id: "${id}"`);
    }

    // Anchor, section id and heading id are all derived from the same spec, so
    // a renamed section cannot leave the contents pointing at nothing.
    expect(cookbook).toContain("href={`#${section.id}`}");
    expect(cookbook).toContain("id={spec.id}");
    expect(cookbook).toContain("aria-labelledby={`${spec.id}-heading`}");
    expect(cookbook).toContain("id={`${spec.id}-heading`}");
  });
});
