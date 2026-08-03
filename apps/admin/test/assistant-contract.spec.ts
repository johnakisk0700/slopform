import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

type AssistantModel =
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.6-terra"
  | "google/gemini-3.6-flash"
  | "qwen/qwen3.7-max";
type AssistantEffort = "low" | "medium" | "high";

interface AssistantContractModule {
  ASSISTANT_MODEL_IDS: readonly AssistantModel[];
  DEFAULT_ASSISTANT_MODEL: AssistantModel;
  ASSISTANT_EFFORTS: readonly AssistantEffort[];
  DEFAULT_ASSISTANT_EFFORT: AssistantEffort;
  assistantFailureMessage: (
    code: "provider_unavailable" | "provider_rejected" | "generation_failed",
  ) => string;
  assistantThreadSchema: {
    parse: (input: unknown) => {
      id: string;
      turns: { status: string; requestId: string }[];
    };
    safeParse: (input: unknown) => { success: boolean };
  };
  assistantTurnSchema: {
    parse: (input: unknown) => { status: string };
    safeParse: (input: unknown) => { success: boolean };
  };
  buildAssistantTurnRequest: (
    requestId: string,
    model: AssistantModel,
    effort: AssistantEffort,
    serviceTier: "standard" | "fast",
    content: string,
  ) => {
    requestId: string;
    model?: AssistantModel;
    effort: AssistantEffort;
    serviceTier: "standard" | "fast";
    content: string;
  };
  assistantModelSupportsServiceTier: (model: AssistantModel) => boolean;
  messagesFromThread: (thread: unknown) => {
    id: string;
    role: "user" | "assistant";
    content: string;
    turnId: string;
    effort: AssistantEffort;
    serviceTier: string;
  }[];
}

interface BackendAssistantContractModule {
  ASSISTANT_MODELS: readonly AssistantModel[];
  DEFAULT_ASSISTANT_MODEL: AssistantModel;
  ASSISTANT_EFFORTS: readonly AssistantEffort[];
  DEFAULT_ASSISTANT_EFFORT: AssistantEffort;
}

const THREAD_ID = "2d431350-522a-4a4e-b4db-f9a225601424";
const TURN_ID = "3f4a7749-98a0-4fea-9ccb-89451a44e481";
const REQUEST_ID = "7b16acc2-2499-4fe1-8818-8047107c66d3";
const CREATED_AT = "2026-07-23T09:30:00.000Z";

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function turn(
  status: "queued" | "running" | "succeeded" | "failed",
  partial: string | null = null,
  serviceTier: "standard" | "fast" = "standard",
  reasoning: string | null = null,
): Record<string, unknown> {
  const terminal = status === "succeeded" || status === "failed";
  return {
    id: TURN_ID,
    requestId: REQUEST_ID,
    sequence: 1,
    status,
    model: "google/gemini-3.6-flash",
    effort: "low",
    serviceTier,
    user: { role: "user", content: "Review this plan." },
    assistant:
      status === "succeeded"
        ? { role: "assistant", content: "Reviewed response." }
        : null,
    partial: terminal ? null : partial,
    reasoning: terminal ? null : reasoning,
    error:
      status === "failed"
        ? { code: "generation_failed", message: "Internal provider detail" }
        : null,
    attempt: 1,
    createdAt: CREATED_AT,
    startedAt: status === "queued" ? null : CREATED_AT,
    completedAt: terminal ? "2026-07-23T09:30:04.000Z" : null,
  };
}

function threadView(status: "queued" | "running" | "succeeded" | "failed") {
  return {
    id: THREAD_ID,
    title: "Review this plan",
    createdAt: CREATED_AT,
    updatedAt: "2026-07-23T09:30:04.000Z",
    turns: [turn(status)],
  };
}

let contract: AssistantContractModule;
let backendContract: BackendAssistantContractModule;
let AssistantMarkdown: ComponentType<{ children?: string }>;

beforeAll(async () => {
  const media = { matches: false, addEventListener: () => {} };
  // The card reuses the same HeroUI chips as the rest of the admin, and those
  // reach react-aria, which installs global listeners on import. The stubs are
  // therefore listener-shaped rather than minimal — server rendering needs the
  // module to load, not a DOM.
  vi.stubGlobal("window", {
    matchMedia: () => media,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: () => {} } },
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { addEventListener: () => {}, removeEventListener: () => {} },
  });

  const contractUrl = new URL(
    "../src/features/assistant/schema.ts",
    import.meta.url,
  ).href;
  contract = (await import(contractUrl)) as AssistantContractModule;

  const backendContractUrl = new URL(
    "../../backend/src/modules/assistant/assistant.schemas.ts",
    import.meta.url,
  ).href;
  backendContract = (await import(
    backendContractUrl
  )) as BackendAssistantContractModule;

  const markdownUrl = new URL(
    "../src/components/admin/assistant/AssistantMarkdown.tsx",
    import.meta.url,
  ).href;
  const markdownModule = (await import(markdownUrl)) as {
    AssistantMarkdown: ComponentType<{ children?: string }>;
  };
  AssistantMarkdown = markdownModule.AssistantMarkdown;
});

describe("durable assistant API boundary", () => {
  it("exposes the requested model IDs and uses Gemini through OpenRouter by default", () => {
    expect(contract.ASSISTANT_MODEL_IDS).toEqual([
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "google/gemini-3.6-flash",
      "qwen/qwen3.7-max",
    ]);
    expect(contract.DEFAULT_ASSISTANT_MODEL).toBe("google/gemini-3.6-flash");
  });

  it("matches the backend's exported model and reasoning-effort contract", () => {
    expect(contract.ASSISTANT_MODEL_IDS).toEqual(
      backendContract.ASSISTANT_MODELS,
    );
    expect(contract.DEFAULT_ASSISTANT_MODEL).toBe(
      backendContract.DEFAULT_ASSISTANT_MODEL,
    );
    expect(contract.ASSISTANT_EFFORTS).toEqual(
      backendContract.ASSISTANT_EFFORTS,
    );
    expect(contract.DEFAULT_ASSISTANT_EFFORT).toBe(
      backendContract.DEFAULT_ASSISTANT_EFFORT,
    );
  });

  it("requires a client request ID so replaying a lost POST is idempotent", () => {
    expect(
      contract.buildAssistantTurnRequest(
        REQUEST_ID,
        "openai/gpt-5.6-terra",
        "high",
        "fast",
        "  Review this plan.  ",
      ),
    ).toEqual({
      requestId: REQUEST_ID,
      model: "openai/gpt-5.6-terra",
      effort: "high",
      serviceTier: "fast",
      content: "Review this plan.",
    });
  });

  // The fast lane doubles the token price and exists only on the OpenAI route,
  // so the control must refuse it rather than send a tier the provider drops.
  it("offers the fast lane only where it can actually be bought", () => {
    expect(
      contract.assistantModelSupportsServiceTier("openai/gpt-5.6-luna"),
    ).toBe(true);
    expect(
      contract.assistantModelSupportsServiceTier("openai/gpt-5.6-terra"),
    ).toBe(true);
    expect(
      contract.assistantModelSupportsServiceTier("google/gemini-3.6-flash"),
    ).toBe(false);
    expect(contract.assistantModelSupportsServiceTier("qwen/qwen3.7-max")).toBe(
      false,
    );
  });

  it("carries the tier a turn ran under into its rendered message", () => {
    const thread = contract.assistantThreadSchema.parse({
      ...threadView("succeeded"),
      turns: [turn("succeeded", null, "fast")],
    });
    expect(contract.messagesFromThread(thread)[1]).toEqual(
      expect.objectContaining({ role: "assistant", serviceTier: "fast" }),
    );
  });

  it("accepts persisted queue and terminal turn states", () => {
    for (const status of [
      "queued",
      "running",
      "succeeded",
      "failed",
    ] as const) {
      expect(contract.assistantTurnSchema.parse(turn(status)).status).toBe(
        status,
      );
      expect(
        contract.assistantThreadSchema.parse(threadView(status)).turns[0]
          ?.status,
      ).toBe(status);
    }
  });

  it("rejects old model IDs and malformed successful turns", () => {
    const stale = turn("queued");
    stale.model = "qwen/qwen3.6-plus";
    const emptySuccess = turn("succeeded");
    emptySuccess.assistant = { role: "assistant", content: " " };

    expect(contract.assistantTurnSchema.safeParse(stale).success).toBe(false);
    expect(contract.assistantTurnSchema.safeParse(emptySuccess).success).toBe(
      false,
    );
  });

  it("matches the backend's 160-character durable thread-title boundary", () => {
    const atLimit = threadView("succeeded");
    atLimit.title = "a".repeat(160);
    const overLimit = threadView("succeeded");
    overLimit.title = "a".repeat(161);

    expect(contract.assistantThreadSchema.safeParse(atLimit).success).toBe(
      true,
    );
    expect(contract.assistantThreadSchema.safeParse(overLimit).success).toBe(
      false,
    );
  });

  it("flattens durable turns into the copied message renderer contract", () => {
    const parsed = contract.assistantThreadSchema.parse(
      threadView("succeeded"),
    );
    expect(contract.messagesFromThread(parsed)).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Review this plan.",
        turnId: TURN_ID,
        effort: "low",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "Reviewed response.",
        turnId: TURN_ID,
        effort: "low",
      }),
    ]);
  });

  it("renders streamed text under the id its durable answer will take", () => {
    const running = contract.assistantThreadSchema.parse({
      ...threadView("running"),
      turns: [turn("running", "Reviewed re")],
    });
    const streamed = contract.messagesFromThread(running);
    expect(streamed).toHaveLength(2);
    expect(streamed[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "Reviewed re",
        status: "running",
      }),
    );

    // The finished answer must replace that message in place — a second bubble
    // would double the reply the moment the turn settles.
    const settled = contract.messagesFromThread(
      contract.assistantThreadSchema.parse(threadView("succeeded")),
    );
    expect(settled[1]?.id).toBe(streamed[1]?.id);
    expect(settled[1]?.content).toBe("Reviewed response.");
  });

  it("refuses streamed text on a settled turn", () => {
    expect(() =>
      contract.assistantTurnSchema.parse({
        ...turn("succeeded"),
        partial: "Reviewed re",
      }),
    ).toThrow();
  });

  it("maps raw provider failures to stable operator-safe copy", () => {
    const copy = contract.assistantFailureMessage("provider_rejected");
    expect(copy).toContain("provider rejected");
    expect(copy).not.toContain("Internal provider detail");
  });
});

describe("assistant Markdown renderer", () => {
  it("sanitises raw model HTML while retaining the narrow expressive tags", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          '<script>alert("bad")</script><img src="x" onerror="alert(1)"><mark>safe</mark>',
      }),
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("<mark>safe</mark>");
  });

  it("renders GFM tables and highlighted fenced code", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          "| Item | Owner |\n| --- | --- |\n| Brief | Ops |\n\n```ts\nconst ready = true;\n```",
      }),
    );

    expect(html).toContain("<table>");
    expect(html).toContain('class="hljs-keyword"');
  });

  it("renders a fenced jts profile and omits the fields the model left out", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          '```jts\n{"kind":"profile","name":"Maria K.","phone":"+306900000000","feedbackOptIn":true}\n```',
      }),
    );

    expect(html).toContain("Maria K.");
    expect(html).toContain("tel:+306900000000");
    expect(html).toContain("Feedback opt-in");
    // Nothing was said about a neighbourhood, so the card says nothing about
    // one — an empty row would read as «none recorded».
    expect(html).not.toContain("Neighborhood");
  });

  it("renders a fenced jts event with its status chip", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          '```jts\n{"kind":"event","title":"Sunday Six","status":"scheduled","venue":"Kafeneio","area":"Pagrati","attendeeCount":6}\n```',
      }),
    );

    expect(html).toContain("Sunday Six");
    expect(html).toContain("Scheduled");
    expect(html).toContain("Kafeneio · Pagrati");
  });

  it("renders a fenced jts conversation and leads with the flag to act on", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          '```jts\n{"kind":"conversation","respondent":"Ειρήνη Κ.","state":"open","control":"human","needsAttention":true,"answered":2,"goalCount":4,"messageCount":11}\n```',
      }),
    );

    expect(html).toContain("Ειρήνη Κ.");
    expect(html).toContain("Needs a person");
    expect(html).toContain("Staff replying");
    expect(html).toContain("2 of 4");
    // The card summarises; testimony stays in the answer as a quotation.
    expect(html).not.toContain("Last reply");
  });

  /**
   * The card is model-authored, so malformed JSON is a matter of when, not if.
   * Falling back to the raw block keeps a bad card visible and the surrounding
   * answer intact, which is the same contract the chart fence already honours.
   */
  it("falls back to the raw block when a card is malformed", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children: '```jts\n{"kind":"profile"}\n```',
      }),
    );

    expect(html).toContain("<pre>");
    expect(html).toContain("&quot;kind&quot;:&quot;profile&quot;");
    expect(html).not.toContain("assistant-card");
  });

  /**
   * A rating average is only readable against the scale it was measured on.
   * Without a ceiling the largest bar is always full, so 4.2 and 2.1 draw the
   * same picture whenever they happen to be the highest number present.
   */
  it("draws bars against the declared scale ceiling rather than the largest value", () => {
    const points =
      '[{"label":"Βραδιά","value":2.5},{"label":"Τραπέζι","value":4}]';
    const scaled = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children: `\`\`\`chart\n{"type":"bar","max":5,"data":${points}}\n\`\`\``,
      }),
    );
    const unscaled = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children: `\`\`\`chart\n{"type":"bar","data":${points}}\n\`\`\``,
      }),
    );

    // 2.5 and 4 on a 1–5 scale: half the scale and four fifths of it.
    expect(scaled).toContain("width:50%");
    expect(scaled).toContain("width:80%");
    expect(scaled).not.toContain("width:100%");
    // The same data with no declared scale still fills to its own largest bar.
    expect(unscaled).toContain("width:62.5%");
    expect(unscaled).toContain("width:100%");
    // A ceiling below the data cannot clip a bar past full width.
    expect(
      renderToStaticMarkup(
        createElement(AssistantMarkdown, {
          children:
            '```chart\n{"type":"bar","max":1,"data":[{"label":"Απαντήσεις","value":4}]}\n```',
        }),
      ),
    ).toContain("width:100%");
  });

  it("keeps a chart whose scale ceiling is unusable and drops only the ceiling", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          '```chart\n{"type":"bar","max":0,"title":"Κατανομή","data":[{"label":"5/5","value":3},{"label":"4/5","value":1}]}\n```',
      }),
    );

    expect(html).toContain("Κατανομή");
    expect(html).toContain("width:100%");
    expect(html).toContain("width:33.33333333333333%");
    expect(html).not.toContain("<pre>");
  });

  it("falls back safely for malformed model-authored chart fields", () => {
    for (const source of [
      '{"type":"pie","data":[{"label":"A","value":1}]}',
      '{"title":{"unsafe":true},"data":[{"label":"A","value":1}]}',
      '{"data":[{"label":{"unsafe":true},"value":1}]}',
      '{"unit":4,"data":[{"label":"A","value":1}]}',
    ]) {
      const html = renderToStaticMarkup(
        createElement(AssistantMarkdown, {
          children: `\`\`\`chart\n${source}\n\`\`\``,
        }),
      );
      expect(html).toContain("<pre>");
      expect(html).not.toContain("assistant-chart");
    }
  });

  it("draws zero as zero and keeps a declared line scale anchored", () => {
    const bars = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          '```chart\n{"type":"bar","max":5,"data":[{"label":"Καμία","value":0},{"label":"Μερικές","value":2.5}]}\n```',
      }),
    );
    expect(bars).toContain("width:0%");
    expect(bars).toContain("width:50%");

    const line = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        children:
          '```chart\n{"type":"line","max":5,"data":[{"label":"A","value":4},{"label":"B","value":5}]}\n```',
      }),
    );
    // With zero as the inferred baseline, 4/5 sits above the middle rather
    // than becoming the plot's artificial floor.
    expect(line).toContain("M 6.0,25.2 L 314.0,10.0");
    expect(line).not.toContain("M 6.0,86.0 L 314.0,10.0");
  });
});

describe("assistant route wiring", () => {
  it("mounts the assistant route and keeps API paths relative to the shared base", () => {
    const app = readAdminFile("src/App.tsx");
    const page = readAdminFile("src/routes/AssistantPage.tsx");

    expect(app).toContain('path="assistant/:threadId?"');
    expect(app).not.toContain('path="assistant/:threadId"');
    expect(app.match(/<AssistantPage \/>/g)).toHaveLength(1);
    expect(page).toContain('ASSISTANT_THREADS_PATH = "/v1/assistant/threads"');
    expect(page).not.toContain('ASSISTANT_THREADS_PATH = "/api/');
    expect(page).toContain('responseType: "stream"');
    expect(page).toContain("consumeAssistantEventStream");
    expect(page).toContain("waitForNextPoll");
  });

  it("preserves exact URL resume, stable streaming layout and non-live history", () => {
    const page = readAdminFile("src/routes/AssistantPage.tsx");
    const conversation = readAdminFile(
      "src/components/admin/assistant/AssistantConversation.tsx",
    );
    const mermaid = readAdminFile(
      "src/components/admin/assistant/AssistantMermaid.tsx",
    );
    const message = readAdminFile(
      "src/components/admin/assistant/AssistantMessage.tsx",
    );

    expect(page).toContain("routeThreadId");
    expect(page).toContain("ResizeObserver");
    expect(page).not.toContain("scrollToBottom");
    expect(page).toContain("requestAnimationFrame(alignLatestQuestion)");
    expect(page).toContain("operationRef.current || isBusy || failure");
    expect(page).toContain("[overflow-anchor:none]");
    expect(conversation).toContain('className="sr-only" aria-live="polite"');
    expect(conversation).toContain('role="log"');
    expect(page).toContain("calculateAssistantReplyMinHeight");
    expect(page).toContain(
      "[activeThreadId, latestUserMessageId, replyMinHeight]",
    );
    expect(page).toContain("skipHydrationThreadIdRef.current = thread.id");
    expect(page).toContain("preserveAssistantLiveAlignment: true");
    expect(page).toContain("useRef(preserveLiveAlignment)");
    expect(page).toContain(
      "preserveLiveAlignment ? (routeThreadId ?? null) : null",
    );
    expect(page).toContain(
      "if (activeThreadId) {\n            alignLatestQuestionRef.current = false",
    );
    expect(conversation).toContain("replyMinHeight");
    expect(message).toContain("style={minHeight");
    expect(conversation).not.toContain(
      'role="log"\n        aria-label="Assistant conversation"\n        aria-live',
    );
    expect(mermaid).toContain("import { useTheme }");
    expect(mermaid).toContain("[chart, isDark, renderId]");
  });

  it("keeps the assistant full-height inside the shell without page-card chrome", () => {
    const shell = readAdminFile("src/components/admin/AdminShell.tsx");
    const page = readAdminFile("src/routes/AssistantPage.tsx");
    const composer = readAdminFile(
      "src/components/admin/assistant/AssistantComposer.tsx",
    );

    // The shell now names two full-height routes rather than special-casing
    // this one, and the assistant is the only one that also paints to the edge.
    expect(shell).toContain('FULL_HEIGHT_ROUTES = ["/admin/assistant"');
    expect(shell).toContain('BLEED_ROUTES = ["/admin/assistant"]');
    expect(shell).toContain("pathname.startsWith(`${route}/`)");
    expect(shell).toContain('"h-full min-h-0"');
    // Desktop names the viewport directly. On mobile the assistant shell owns
    // h-dvh, so main can safely take the remaining height below the top bar.
    expect(shell).toContain("lg:h-dvh");
    expect(shell).toContain('MOBILE_VIEWPORT_ROUTES = ["/admin/assistant"]');
    expect(shell).toContain('"h-dvh flex-none overflow-hidden"');
    expect(shell).toContain('"min-h-0 flex-1 lg:flex-none"');
    expect(page).toContain(
      'className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"',
    );
    expect(page).not.toContain("JtsPageHeader");
    expect(page).not.toContain("h-[clamp(36rem,72dvh,52rem)]");
    expect(composer).toContain("focus-within:border-primary-border");
    expect(composer).not.toContain("focus-within:ring-");
    expect(composer).toContain("focus:ring-0");
    expect(composer).toContain("focus-visible:ring-0");
    expect(page).toContain("isBusy={isGenerating}");
    expect(page).toContain('isLoading={phase === "loading"}');
    expect(composer).toContain("disabled || isLoading || !value.trim()");
  });

  it("uses real Gemini and Qwen marks and notes_ai selector geometry", () => {
    const providerIcon = readAdminFile(
      "src/components/admin/assistant/AssistantProviderIcon.tsx",
    );
    const selector = readAdminFile(
      "src/components/admin/assistant/AssistantModelSelector.tsx",
    );

    expect(providerIcon).toContain("GEMINI_PATH");
    expect(providerIcon).toContain("QWEN_PATH");
    expect(providerIcon).not.toContain("<text");
    expect(selector).toContain('placement="top start"');
    expect(selector).toContain(
      "w-80 max-w-[calc(100vw-2rem)] rounded-lg border",
    );
    expect(selector).toContain('className="p-2"');
    expect(selector).toContain("h-8 gap-1.5 rounded-sm px-2 text-xs");
  });

  it("keeps conversation chrome single-line and assistant marginalia aligned", () => {
    const page = readAdminFile("src/routes/AssistantPage.tsx");
    const message = readAdminFile(
      "src/components/admin/assistant/AssistantMessage.tsx",
    );
    const thinking = readAdminFile(
      "src/components/admin/assistant/AssistantThinkingIndicator.tsx",
    );

    expect(page).toContain("{({ selectedText }) => selectedText}");
    expect(page).toContain('className="min-w-0 flex-1 truncate text-left"');
    expect(page).not.toContain("phaseLabel");
    expect(page).not.toContain("ScrollShadow");
    expect(message).toContain(
      'className="mt-1.5 flex items-center gap-0.5 text-ink-muted"',
    );
    expect(message).toContain(
      'className="ml-1.5 font-mono text-[length:var(--jts-text-2xs)]',
    );
    expect(thinking).toContain(
      "items-center gap-1.5 font-mono text-xs text-ink-muted",
    );
  });

  it("offers explicit retry, revise and discard recovery paths", () => {
    const page = readAdminFile("src/routes/AssistantPage.tsx");
    const conversation = readAdminFile(
      "src/components/admin/assistant/AssistantConversation.tsx",
    );

    expect(page).toContain('kind: "submission"');
    expect(page).toContain("reviseFailure");
    expect(conversation).toContain("Revise as new request");
    expect(page).toContain("Discard & start new");
  });

  it("branches edits into a new durable thread and offers artifact-aware copy", () => {
    const page = readAdminFile("src/routes/AssistantPage.tsx");
    const message = readAdminFile(
      "src/components/admin/assistant/AssistantMessage.tsx",
    );

    expect(page).toContain('kind: "branch"');
    expect(page).toContain("buildBranchAssistantThreadRequest");
    expect(page).toContain("onBranchMessage={branchFromMessage}");
    expect(message).toContain("Edit into a new conversation");
    expect(message).toContain("Continue in new chat");
    expect(message).toContain('id="answer-with-activity"');
    expect(message).toContain("formatAssistantMessageForCopy(message, mode)");
  });

  it("keeps notes_ai's optimized renderer boundaries explicit", () => {
    const message = readAdminFile(
      "src/components/admin/assistant/AssistantMessage.tsx",
    );
    const markdown = readAdminFile(
      "src/components/admin/assistant/AssistantMarkdown.tsx",
    );

    expect(message).toContain("memo(");
    expect(markdown).toContain("rehypeRaw");
    expect(markdown).toContain("rehypeSanitize");
    expect(markdown.indexOf("rehypeRaw")).toBeLessThan(
      markdown.lastIndexOf("rehypeSanitize"),
    );
    expect(markdown).toContain("rehypeHighlight");
  });
});
