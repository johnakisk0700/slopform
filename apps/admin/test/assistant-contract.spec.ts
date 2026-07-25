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
    content: string,
  ) => {
    requestId: string;
    model?: AssistantModel;
    effort: AssistantEffort;
    content: string;
  };
  messagesFromThread: (thread: unknown) => {
    role: "user" | "assistant";
    content: string;
    turnId: string;
    effort: AssistantEffort;
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
): Record<string, unknown> {
  const terminal = status === "succeeded" || status === "failed";
  return {
    id: TURN_ID,
    requestId: REQUEST_ID,
    sequence: 1,
    status,
    model: "google/gemini-3.6-flash",
    effort: "low",
    user: { role: "user", content: "Review this plan." },
    assistant:
      status === "succeeded"
        ? { role: "assistant", content: "Reviewed response." }
        : null,
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
  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: () => {} } },
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
        "  Review this plan.  ",
      ),
    ).toEqual({
      requestId: REQUEST_ID,
      model: "openai/gpt-5.6-terra",
      effort: "high",
      content: "Review this plan.",
    });
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
});

describe("assistant route wiring", () => {
  it("mounts the assistant route and keeps API paths relative to the shared base", () => {
    const app = readAdminFile("src/App.tsx");
    const page = readAdminFile("src/routes/AssistantPage.tsx");

    expect(app).toContain('path="assistant"');
    expect(app).toContain('path="assistant/:threadId"');
    expect(page).toContain('ASSISTANT_THREADS_PATH = "/v1/assistant/threads"');
    expect(page).not.toContain('ASSISTANT_THREADS_PATH = "/api/');
  });

  it("preserves exact URL resume, hydration scrolling and non-live history", () => {
    const page = readAdminFile("src/routes/AssistantPage.tsx");
    const conversation = readAdminFile(
      "src/components/admin/assistant/AssistantConversation.tsx",
    );
    const mermaid = readAdminFile(
      "src/components/admin/assistant/AssistantMermaid.tsx",
    );

    expect(page).toContain("routeThreadId");
    expect(page).toContain("ResizeObserver");
    expect(page).toContain("requestAnimationFrame(scrollToBottom)");
    expect(page).toContain("operationRef.current || isBusy || failure");
    expect(conversation).toContain('className="sr-only" aria-live="polite"');
    expect(conversation).toContain('role="log"');
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

    expect(shell).toContain('pathname.startsWith("/admin/assistant/")');
    expect(shell).toContain('"h-full min-h-0"');
    expect(page).toContain(
      'className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"',
    );
    expect(page).not.toContain("JtsPageHeader");
    expect(page).not.toContain("h-[clamp(36rem,72dvh,52rem)]");
    expect(composer).toContain("focus-within:ring-primary-border");
    expect(composer).toContain("focus:ring-0");
    expect(composer).toContain("focus-visible:ring-0");
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
