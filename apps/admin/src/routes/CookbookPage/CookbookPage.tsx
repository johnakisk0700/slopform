import { SunMoon } from "lucide-react";

import { JtsPageHeader } from "../../components/ui/JtsPageHeader";
import { usePageMeta } from "../../lib/usePageMeta";

import { AssistantSection } from "./AssistantSection";
import { ColourSection } from "./ColourSection";
import { SECTIONS } from "./cookbookSections";
import { FeedbackSection } from "./FeedbackSection";
import { HeroUISection } from "./HeroUISection";
import { JtsSection } from "./JtsSection";
import { MotifsSection } from "./MotifsSection";
import { TypographySection } from "./TypographySection";

export function CookbookPage() {
  usePageMeta(
    "Cookbook",
    "Development-only gallery of the admin panel's visual vocabulary.",
  );

  return (
    <div className="grid gap-8">
      <JtsPageHeader
        title="Cookbook"
        description="Every colour, type step, HeroUI primitive and project component the admin panel is built from, on one page. Change a token and watch what moves."
      />

      <div
        role="note"
        className="flex items-start gap-3 rounded-md border border-copper/35 bg-copper-soft px-4 py-3 text-sm text-ink-muted"
      >
        <SunMoon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-copper"
        />
        <span>
          To audit dark mode, flip{" "}
          <strong className="text-ink">Appearance</strong> in the operator menu
          (sidebar footer) and read this page again; to audit a palette, pick a{" "}
          <strong className="text-ink">Theme</strong> in the same menu — every
          specimen on this page repaints with it. There is no side-by-side
          preview on purpose: the <code>dark</code> class on{" "}
          <code>&lt;html&gt;</code> is the only dark-mode signal, and a faked
          second theme would be the one thing on this page that cannot be
          trusted.
        </span>
      </div>

      <nav aria-label="Cookbook sections">
        <ul className="flex flex-wrap gap-2">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-1 text-xs font-semibold text-ink no-underline transition-colors hover:border-primary-border hover:text-primary"
              >
                <section.Icon aria-hidden="true" className="size-3.5" />
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* 01 — Colour ---------------------------------------------------------- */}
      <ColourSection />

      {/* 02 — Typography ------------------------------------------------------ */}
      <TypographySection />

      {/* 03 — HeroUI ---------------------------------------------------------- */}
      <HeroUISection />

      {/* 04 — Jts components -------------------------------------------------- */}
      <JtsSection />

      {/* 05 — Feedback vocabulary --------------------------------------------- */}
      <FeedbackSection />

      {/* 06 — Assistant activity ---------------------------------------------- */}
      <AssistantSection />

      {/* 07 — Motifs & rules -------------------------------------------------- */}
      <MotifsSection />
    </div>
  );
}
