import { useEffect, useId, useState } from "react";

import { useTheme } from "../../../lib/useTheme";

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;

function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidPromise ??= import("mermaid");
  return mermaidPromise;
}

/**
 * Lazily render model-authored Mermaid. Strict mode sanitises diagram output;
 * invalid or incomplete source remains readable as a code block.
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
        const mermaid = (await loadMermaid()).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "neutral",
          fontFamily:
            getComputedStyle(document.documentElement).getPropertyValue(
              "--jts-font-sans",
            ) || "sans-serif",
        });
        const valid = await mermaid.parse(chart, { suppressErrors: true });
        if (cancelled || !valid) {
          if (!cancelled) setSvg("");
          return;
        }
        const rendered = await mermaid.render(renderId, chart);
        if (!cancelled) setSvg(rendered.svg);
      } catch {
        if (!cancelled) setSvg("");
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
