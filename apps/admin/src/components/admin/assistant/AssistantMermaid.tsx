import { useEffect, useId, useState } from "react";

import {
  mermaidThemeCss,
  mermaidThemeVariables,
  resolveMermaidPalette,
  withMermaidRoleDefs,
  type MermaidPalette,
} from "../../../lib/mermaidTheme";
import { useTheme } from "../../../lib/useTheme";

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;

function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidPromise ??= import("mermaid");
  return mermaidPromise;
}

function readSansFont(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--jts-font-sans")
      .trim() || "sans-serif"
  );
}

/**
 * Lazily render Mermaid with the admin token palette.
 *
 * Sources stay plain Mermaid — no `%%init%%`, `style` or `classDef`. Flowcharts
 * may tag nodes with `:::decision|info|data|ok|risk|ext`; classDefs are injected
 * from status/brand tokens at render time (same idea as the bento-portfolio
 * MermaidBlock, without illustrated image nodes).
 *
 * Strict mode sanitises diagram output; invalid source remains readable as a
 * code block.
 */
export function AssistantMermaid({ chart }: { chart: string }) {
  const reactId = useId();
  const renderId = `assistant-mermaid-${reactId.replace(/[^a-z0-9_-]/gi, "")}`;
  const [svg, setSvg] = useState("");
  const { isDark } = useTheme();

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram(): Promise<void> {
      try {
        const palette: MermaidPalette | null = resolveMermaidPalette();
        if (!palette) {
          if (!cancelled) setSvg("");
          return;
        }

        const mermaid = (await loadMermaid()).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: readSansFont(),
          themeVariables: mermaidThemeVariables(palette),
          themeCSS: mermaidThemeCss(palette),
          flowchart: {
            curve: "basis",
            padding: 12,
            nodeSpacing: 36,
            rankSpacing: 40,
            htmlLabels: true,
            useMaxWidth: true,
          },
          sequence: {
            mirrorActors: false,
            messageMargin: 36,
            actorMargin: 48,
            useMaxWidth: true,
          },
        });

        const themedChart = withMermaidRoleDefs(chart, palette);
        const valid = await mermaid.parse(themedChart, {
          suppressErrors: true,
        });
        if (cancelled || !valid) {
          if (!cancelled) setSvg("");
          return;
        }
        const rendered = await mermaid.render(renderId, themedChart);
        if (!cancelled) setSvg(rendered.svg);
      } catch {
        if (!cancelled) setSvg("");
        document.getElementById(`d${renderId}`)?.remove();
      }
    }

    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [chart, isDark, renderId]);

  if (!svg) return <pre className="opacity-60">{chart}</pre>;

  // Mermaid's securityLevel=strict sanitises the generated SVG.
  return (
    <div
      className="assistant-mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
