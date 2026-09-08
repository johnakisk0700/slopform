import {
  Bot,
  Boxes,
  Component,
  MessagesSquare,
  Palette,
  Ruler,
  Type,
  type LucideIcon,
} from "lucide-react";

/* -----------------------------------------------------------------------------
   Section spine — the table of contents and the headings read from one list, so
   an anchor can never point at a section that was renamed or removed.
   ----------------------------------------------------------------------------- */

export interface SectionSpec {
  id: string;
  title: string;
  Icon: LucideIcon;
  /** The one-line reason this section is on the page. */
  lede: string;
}

export const COLOUR_SECTION: SectionSpec = {
  id: "colour",
  title: "Colour tokens",
  Icon: Palette,
  lede: "Every semantic colour the bridge exposes, painted by the utility a component would actually write.",
};

export const TYPE_SECTION: SectionSpec = {
  id: "type",
  title: "Typography",
  Icon: Type,
  lede: "Manrope for UI/body, Commissioner for display — both Latin and Greek — plus the scale, weights and numerals built on them.",
};

export const HEROUI_SECTION: SectionSpec = {
  id: "heroui",
  title: "HeroUI components",
  Icon: Component,
  lede: "Live components, not pictures of them. A bridge edit repaints this section in place.",
};

export const JTS_SECTION: SectionSpec = {
  id: "jts",
  title: "Jts components",
  Icon: Boxes,
  lede: "The shared operational contracts every screen composes from.",
};

export const FEEDBACK_SECTION: SectionSpec = {
  id: "feedback",
  title: "Feedback vocabulary",
  Icon: MessagesSquare,
  lede: "The status pills, ids and machine values the feedback screens speak in.",
};

export const ASSISTANT_SECTION: SectionSpec = {
  id: "assistant",
  title: "Assistant activity",
  Icon: Bot,
  lede: "The disclosures a model turn leaves behind — thinking and tool calls — in every state a conversation can show them.",
};

export const MOTIF_SECTION: SectionSpec = {
  id: "motifs",
  title: "Motifs & rules",
  Icon: Ruler,
  lede: "The sanctioned emphasis devices, and the invariants that keep them the only ones.",
};

/** Reading order. The table of contents and the section numerals both read it. */
export const SECTIONS: readonly SectionSpec[] = [
  COLOUR_SECTION,
  TYPE_SECTION,
  HEROUI_SECTION,
  JTS_SECTION,
  FEEDBACK_SECTION,
  ASSISTANT_SECTION,
  MOTIF_SECTION,
];
