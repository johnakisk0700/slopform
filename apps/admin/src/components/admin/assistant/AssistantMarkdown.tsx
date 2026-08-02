import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { AssistantCard } from "./AssistantCard";
import { AssistantChart } from "./AssistantChart";
import { AssistantMermaid } from "./AssistantMermaid";

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "kbd", "sub", "sup"],
};

function isFencedAs(node: unknown, language: string): boolean {
  const child = (
    node as {
      children?: {
        tagName?: string;
        properties?: { className?: unknown };
      }[];
    }
  )?.children?.[0];
  const className = child?.properties?.className;

  return (
    child?.tagName === "code" &&
    Array.isArray(className) &&
    className.includes(`language-${language}`)
  );
}

const components: Components = {
  pre({ node, children }) {
    if (
      isFencedAs(node, "chart") ||
      isFencedAs(node, "mermaid") ||
      isFencedAs(node, "jts")
    ) {
      return <>{children}</>;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children }) {
    const text = String(children ?? "").replace(/\n$/, "");
    if (className?.includes("language-jts")) {
      return <AssistantCard source={text} />;
    }
    if (className?.includes("language-chart")) {
      return <AssistantChart source={text} />;
    }
    if (className?.includes("language-mermaid")) {
      return <AssistantMermaid chart={text} />;
    }
    return <code className={className}>{children}</code>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

/**
 * Memoisation is intentional: Markdown parsing, sanitising and highlighting is
 * the expensive part of message rendering; finalized turns should parse once.
 */
export const AssistantMarkdown = memo(({ children }: { children?: string }) => (
  <Markdown
    remarkPlugins={[remarkGfm, remarkBreaks]}
    // Security-critical order: raw HTML -> sanitize -> syntax highlighting.
    rehypePlugins={[
      rehypeRaw,
      [rehypeSanitize, sanitizeSchema],
      [
        rehypeHighlight,
        { ignoreMissing: true, plainText: ["chart", "mermaid", "jts"] },
      ],
    ]}
    components={components}
  >
    {children}
  </Markdown>
));

AssistantMarkdown.displayName = "AssistantMarkdown";
