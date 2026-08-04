/**
 * Resolve JTS semantic tokens to concrete hex for Mermaid.
 *
 * Mermaid does its own color math and cannot parse `oklch()` / `color-mix()`
 * values from `tokens.css`. Canvas fillStyle accepts whatever the browser
 * resolved, so we turn each token into `#rrggbb` at render time and re-resolve
 * when the theme flips.
 *
 * Flowchart node roles (`:::decision`, `:::data`, …) map onto existing status
 * / brand tokens — no mermaid-only colours in the design-token package.
 */

export const MERMAID_FLOW_ROLES = [
  "decision",
  "info",
  "data",
  "ok",
  "risk",
  "ext",
] as const;

export type MermaidFlowRole = (typeof MERMAID_FLOW_ROLES)[number];

const SURFACE_TOKENS = [
  "--jts-color-surface",
  "--jts-color-surface-sunken",
  "--jts-color-surface-raised",
  "--jts-color-text",
  "--jts-color-text-muted",
  "--jts-color-border",
  "--jts-color-primary",
  "--jts-color-primary-soft",
  "--jts-color-accent",
  "--jts-color-success",
  "--jts-color-warning",
  "--jts-color-danger",
  "--jts-color-info",
] as const;

const ROLE_INK_TOKEN: Record<MermaidFlowRole, (typeof SURFACE_TOKENS)[number]> =
  {
    decision: "--jts-color-warning",
    info: "--jts-color-info",
    data: "--jts-color-primary",
    ok: "--jts-color-success",
    risk: "--jts-color-danger",
    ext: "--jts-color-text-muted",
  };

export type MermaidPalette = Record<(typeof SURFACE_TOKENS)[number], string>;

/** Linear blend of two `#rrggbb` colours; `weight` is the share of `a`. */
export function mixHex(a: string, b: string, weight: number): string {
  const pa = a.match(/\w\w/g)?.map((h) => Number.parseInt(h, 16));
  const pb = b.match(/\w\w/g)?.map((h) => Number.parseInt(h, 16));
  if (!pa || !pb) return a;
  return `#${pa
    .map((v, i) =>
      Math.round(v * weight + (pb[i] ?? 0) * (1 - weight))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function resolveMermaidPalette(): MermaidPalette | null {
  const styles = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const palette = {} as MermaidPalette;
  for (const token of SURFACE_TOKENS) {
    const raw = styles.getPropertyValue(token).trim();
    ctx.fillStyle = "#000000";
    ctx.fillStyle = raw || "#000000";
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    palette[token] = `#${[r, g, b]
      .map((v) => (v ?? 0).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return palette;
}

/**
 * Inject `classDef` lines for flowchart role tags. Article/page sources never
 * carry style or classDef themselves — only `:::role` suffixes.
 */
export function withMermaidRoleDefs(
  chart: string,
  palette: MermaidPalette,
): string {
  if (!/^\s*(flowchart|graph)\b/m.test(chart)) return chart;
  const surface = palette["--jts-color-surface"];
  const ink = palette["--jts-color-text"];
  const defs = MERMAID_FLOW_ROLES.map((role) => {
    const roleInk = palette[ROLE_INK_TOKEN[role]];
    const fill = mixHex(roleInk, surface, 0.18);
    return `classDef ${role} fill:${fill},stroke:${roleInk},color:${ink}`;
  });
  return `${chart.trimEnd()}\n${defs.join("\n")}`;
}

export function mermaidThemeVariables(palette: MermaidPalette) {
  const surface = palette["--jts-color-surface"];
  const sunken = palette["--jts-color-surface-sunken"];
  const raised = palette["--jts-color-surface-raised"];
  const text = palette["--jts-color-text"];
  const muted = palette["--jts-color-text-muted"];
  const border = palette["--jts-color-border"];
  const primary = palette["--jts-color-primary"];
  const soft = palette["--jts-color-primary-soft"];
  const accent = palette["--jts-color-accent"];

  return {
    background: sunken,
    primaryColor: mixHex(primary, surface, 0.14),
    primaryTextColor: text,
    primaryBorderColor: mixHex(primary, border, 0.55),
    secondaryColor: soft,
    tertiaryColor: raised,
    lineColor: muted,
    textColor: text,
    mainBkg: mixHex(primary, surface, 0.12),
    nodeBorder: mixHex(primary, border, 0.5),
    clusterBkg: mixHex(accent, surface, 0.08),
    clusterBorder: mixHex(accent, border, 0.4),
    titleColor: text,
    // Fallback if the square rect leaks through — match the diagram surface.
    edgeLabelBackground: sunken,
    actorBkg: mixHex(primary, surface, 0.12),
    actorBorder: mixHex(primary, border, 0.5),
    actorTextColor: text,
    actorLineColor: muted,
    signalColor: muted,
    signalTextColor: text,
    labelBoxBkgColor: mixHex(accent, surface, 0.14),
    labelBoxBorderColor: mixHex(accent, border, 0.45),
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: mixHex(accent, surface, 0.16),
    noteTextColor: text,
    noteBorderColor: mixHex(accent, border, 0.45),
    activationBkgColor: mixHex(primary, surface, 0.2),
    activationBorderColor: primary,
    sequenceNumberColor: text,
    fontSize: "14px",
  };
}

/**
 * Rounded nodes, thicker edges, and pill edge labels.
 *
 * Mermaid draws a square `rect` behind every edge label; we hide that rect and
 * paint only the rounded HTML chip so «ναι» / «όχι» keep a soft pill without
 * the weird sharp slab underneath.
 */
export function mermaidThemeCss(palette: MermaidPalette): string {
  const sunken = palette["--jts-color-surface-sunken"];
  const text = palette["--jts-color-text"];
  const border = palette["--jts-color-border"];

  return `
    .node rect,
    .node polygon,
    .node circle,
    .node path { stroke-width: 1.5px !important; }
    .node rect { rx: 12px !important; ry: 12px !important; }
    .node .label div,
    .node .label p,
    .node .label span,
    .node foreignObject div,
    .node foreignObject span,
    .node foreignObject p { background: transparent !important; }
    .node .label p { color: ${text} !important; font-weight: 600 !important; }

    /* Kill Mermaid's square label backdrop — keep only our rounded pill. */
    .edgeLabel > rect,
    .edgeLabel rect.background,
    .edgeLabel .label > rect,
    rect.edgeLabel {
      fill: none !important;
      stroke: none !important;
      opacity: 0 !important;
    }
    .edgeLabel,
    .edgeLabel .labelBkg,
    .edgeLabel foreignObject > div {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      padding: 0 !important;
    }
    .edgeLabel p,
    .edgeLabel span {
      color: ${text} !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      background: transparent !important;
      margin: 0 !important;
    }
    /* Neutral chip: same fill as the diagram surface, hairline border, pill radius. */
    .edgeLabel > .label > foreignObject > .labelBkg > span.edgeLabel:not(:empty),
    .edgeLabel span.edgeLabel:not(:empty) {
      display: inline-block !important;
      background: ${sunken} !important;
      border: 1px solid ${border} !important;
      border-radius: 999px !important;
      box-sizing: border-box !important;
      padding: 2px 8px !important;
    }
    .edgeLabel > .label > foreignObject > .labelBkg > span.edgeLabel:not(:empty) > p,
    .edgeLabel span.edgeLabel:not(:empty) > p {
      background: transparent !important;
      margin: 0 !important;
    }

    .flowchart-link { stroke-width: 2px !important; }
    .actor { stroke-width: 1.5px !important; }
    .messageLine0, .messageLine1 { stroke-width: 1.75px !important; }
    .loopLine { stroke-width: 1.5px !important; }
    .sequenceNumber { font-weight: 700 !important; }
  `;
}
