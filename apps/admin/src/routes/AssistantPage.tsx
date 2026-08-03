import { Button, Chip, ListBox, ScrollShadow, Select } from "@heroui/react";
import { clsx } from "clsx";
import { MessageSquarePlus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router";

import { AssistantComposer } from "../components/admin/assistant/AssistantComposer";
import { AssistantConversation } from "../components/admin/assistant/AssistantConversation";
import {
  EFFORT_STORAGE_KEY,
  MODEL_STORAGE_KEY,
  SERVICE_TIER_STORAGE_KEY,
  readSavedEffort,
  readSavedModel,
  readSavedServiceTier,
} from "../features/assistant/composerSettings";
import {
  requestFailureMessage,
  responseStatus,
} from "../features/assistant/failureMessages";
import {
  calculateAssistantQuestionScrollTop,
  calculateAssistantReplyMinHeight,
} from "../features/assistant/layout";
import {
  assistantFailureMessage,
  assistantThreadListSchema,
  assistantThreadSchema,
  assistantTurnSchema,
  buildAssistantTurnRequest,
  messagesFromThread,
  type AssistantDisplayMessage,
  type AssistantEffort,
  type AssistantModel,
  type AssistantServiceTier,
  type AssistantThread,
  type AssistantThreadSummary,
  type AssistantTurn,
  type AssistantTurnStatus,
} from "../features/assistant/schema";
import {
  consumeAssistantEventStream,
  overlayAssistantLiveTurn,
  reduceAssistantLiveTurn,
  type AssistantLiveTurn,
  type AssistantStreamFrame,
} from "../features/assistant/stream";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/dateTime";
import { usePageMeta } from "../lib/usePageMeta";

const ASSISTANT_THREADS_PATH = "/v1/assistant/threads";
const POLL_INTERVAL_MS = 1_200;
const NEW_THREAD_KEY = "new";

type PagePhase = "loading" | "idle" | "submitting" | AssistantTurnStatus;

type AssistantAction =
  | { kind: "initial"; threadId: string | null }
  | { kind: "load"; threadId: string }
  | {
      kind: "create";
      requestId: string;
      model: AssistantModel;
      effort: AssistantEffort;
      serviceTier: AssistantServiceTier;
      content: string;
    }
  | {
      kind: "append";
      threadId: string;
      requestId: string;
      model: AssistantModel;
      effort: AssistantEffort;
      serviceTier: AssistantServiceTier;
      content: string;
    }
  | { kind: "poll"; threadId: string; turnId: string }
  | { kind: "retry"; threadId: string; turnId: string };

interface PageFailure {
  kind: "submission" | "durable" | "recovery";
  message: string;
  action: AssistantAction;
  retryLabel: string;
  revision: PendingUserMessage | null;
}

interface PendingUserMessage {
  requestId: string;
  model: AssistantModel;
  effort: AssistantEffort;
  serviceTier: AssistantServiceTier;
  content: string;
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timeoutId = 0;

    const finish = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    timeoutId = window.setTimeout(finish, POLL_INTERVAL_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function turnPath(threadId: string, turnId: string): string {
  return `${ASSISTANT_THREADS_PATH}/${threadId}/turns/${turnId}`;
}

async function watchAssistantStream(
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  onFrame: (frame: AssistantStreamFrame) => void,
): Promise<boolean> {
  const response = await api.raw<never, "stream">(
    `${turnPath(threadId, turnId)}/stream`,
    {
      headers: { Accept: "text/event-stream" },
      responseType: "stream",
      retry: 0,
      // The ordinary client timeout protects finite requests. This response is
      // intentionally open for the provider's full two-minute generation bound.
      timeout: 0,
      signal,
    },
  );
  const stream = response._data ?? response.body;
  if (!stream) return false;

  let completed = false;
  await consumeAssistantEventStream(stream, (frame) => {
    if (frame.kind === "done") completed = true;
    onFrame(frame);
  });
  return completed;
}

function replaceOrAppendTurn(
  thread: AssistantThread,
  turn: AssistantTurn,
): AssistantThread {
  const existingIndex = thread.turns.findIndex(
    (candidate) => candidate.id === turn.id,
  );
  const turns = [...thread.turns];
  if (existingIndex >= 0) turns[existingIndex] = turn;
  else turns.push(turn);

  return { ...thread, turns };
}

function clearLiveTurn(
  current: AssistantLiveTurn | null,
  turnId: string,
  attempt: number,
): AssistantLiveTurn | null {
  return current?.turnId === turnId && current.attempt === attempt
    ? null
    : current;
}

function phaseLabel(phase: PagePhase): string {
  switch (phase) {
    case "loading":
      return "Loading";
    case "submitting":
      return "Submitting";
    case "queued":
      return "Queued";
    case "running":
      return "Generating";
    case "failed":
      return "Needs attention";
    case "succeeded":
    case "idle":
      return "Ready";
  }
}

/** Durable, queue-backed assistant with the notes_ai chat renderer and shell. */
export function AssistantPage() {
  usePageMeta(
    "AI assistant",
    "Durable AI conversations for Join The Six event operations.",
  );

  const navigate = useNavigate();
  const { threadId: routeThreadId } = useParams<{ threadId?: string }>();

  const [threads, setThreads] = useState<AssistantThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<AssistantThread | null>(
    null,
  );
  const [liveTurn, setLiveTurn] = useState<AssistantLiveTurn | null>(null);
  const [pendingUser, setPendingUser] = useState<PendingUserMessage | null>(
    null,
  );
  const [composer, setComposer] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] =
    useState<AssistantModel>(readSavedModel);
  const [selectedEffort, setSelectedEffort] =
    useState<AssistantEffort>(readSavedEffort);
  const [selectedServiceTier, setSelectedServiceTier] =
    useState<AssistantServiceTier>(readSavedServiceTier);
  const [phase, setPhase] = useState<PagePhase>("loading");
  const [failure, setFailure] = useState<PageFailure | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [replyMinHeight, setReplyMinHeight] = useState<number | null>(null);
  const [conversationBottomClearance, setConversationBottomClearance] =
    useState(160);
  const operationRef = useRef<AbortController | null>(null);
  const suppressedRouteLoadRef = useRef<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerContainerRef = useRef<HTMLFormElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const alignLatestQuestionRef = useRef(false);
  const skipHydrationThreadIdRef = useRef<string | null>(null);
  const previousThreadIdRef = useRef<string | null>(null);

  const isBusy =
    phase === "loading" ||
    phase === "submitting" ||
    phase === "queued" ||
    phase === "running";

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const executeAction = useCallback(
    async (action: AssistantAction): Promise<void> => {
      if (operationRef.current) return;

      const controller = new AbortController();
      operationRef.current = controller;
      setLiveTurn(null);
      let recoveryAction: AssistantAction = action;
      setFailure(null);
      setPhase(
        action.kind === "initial" || action.kind === "load"
          ? "loading"
          : action.kind === "poll"
            ? "queued"
            : "submitting",
      );

      async function fetchThread(threadId: string): Promise<AssistantThread> {
        const rawThread: unknown = await api(
          `${ASSISTANT_THREADS_PATH}/${threadId}`,
          { signal: controller.signal },
        );
        return assistantThreadSchema.parse(rawThread);
      }

      async function refreshThreadList(): Promise<AssistantThreadSummary[]> {
        const rawList: unknown = await api(ASSISTANT_THREADS_PATH, {
          signal: controller.signal,
        });
        const parsed = assistantThreadListSchema.parse(rawList).items;
        setThreads(parsed);
        return parsed;
      }

      async function watchTurn(
        threadId: string,
        initialTurn: AssistantTurn,
      ): Promise<void> {
        let turn = initialTurn;
        const streamAttempt = initialTurn.attempt;
        recoveryAction = { kind: "poll", threadId, turnId: turn.id };
        const streamController = new AbortController();
        const stopStream = () => streamController.abort();
        controller.signal.addEventListener("abort", stopStream, { once: true });
        const livePromise = watchAssistantStream(
          threadId,
          turn.id,
          streamController.signal,
          (frame) => {
            if (streamController.signal.aborted) return;
            setLiveTurn((current) =>
              reduceAssistantLiveTurn(current, turn.id, frame),
            );
          },
        )
          .then((completed) => {
            if (!completed && !streamController.signal.aborted) {
              setLiveTurn((current) =>
                clearLiveTurn(current, turn.id, streamAttempt),
              );
            }
          })
          .catch(() => {
            if (!streamController.signal.aborted) {
              setLiveTurn((current) =>
                clearLiveTurn(current, turn.id, streamAttempt),
              );
            }
          });

        try {
          while (
            !controller.signal.aborted &&
            (turn.status === "queued" || turn.status === "running")
          ) {
            setPhase(turn.status);
            await waitForNextPoll(controller.signal);
            if (controller.signal.aborted) return;

            const rawTurn: unknown = await api(turnPath(threadId, turn.id), {
              signal: controller.signal,
            });
            turn = assistantTurnSchema.parse(rawTurn);
            setActiveThread((current) =>
              current?.id === threadId
                ? replaceOrAppendTurn(current, turn)
                : current,
            );
          }

          if (controller.signal.aborted) return;

          const persistedThread = await fetchThread(threadId);
          setActiveThread(persistedThread);
          setPendingUser(null);
          await refreshThreadList();

          if (turn.status === "failed") {
            setPhase("failed");
            setAnnouncement("Assistant turn failed and needs attention.");
            setFailure({
              kind: "durable",
              message: assistantFailureMessage(turn.error.code),
              action: { kind: "retry", threadId, turnId: turn.id },
              retryLabel: "Retry turn",
              revision: {
                requestId: turn.requestId,
                model: turn.model,
                effort: turn.effort,
                serviceTier: turn.serviceTier,
                content: turn.user.content,
              },
            });
            return;
          }

          setPhase("idle");
          setAnnouncement("Assistant response ready.");
          focusComposer();
        } finally {
          streamController.abort();
          await livePromise;
          controller.signal.removeEventListener("abort", stopStream);
          setLiveTurn((current) =>
            clearLiveTurn(current, turn.id, streamAttempt),
          );
        }
      }

      async function adoptThread(thread: AssistantThread): Promise<void> {
        setActiveThread(thread);
        setPendingUser(null);
        const lastTurn = thread.turns.at(-1);

        if (!lastTurn) {
          setPhase("idle");
          return;
        }

        if (lastTurn.status === "failed") {
          setPhase("failed");
          setFailure({
            kind: "durable",
            message: assistantFailureMessage(lastTurn.error.code),
            action: {
              kind: "retry",
              threadId: thread.id,
              turnId: lastTurn.id,
            },
            retryLabel: "Retry turn",
            revision: {
              requestId: lastTurn.requestId,
              model: lastTurn.model,
              effort: lastTurn.effort,
              serviceTier: lastTurn.serviceTier,
              content: lastTurn.user.content,
            },
          });
          return;
        }

        if (lastTurn.status === "queued" || lastTurn.status === "running") {
          await watchTurn(thread.id, lastTurn);
          return;
        }

        setPhase("idle");
      }

      try {
        switch (action.kind) {
          case "initial": {
            await refreshThreadList();
            if (!action.threadId) {
              setActiveThread(null);
              setPendingUser(null);
              setPhase("idle");
              return;
            }
            await adoptThread(await fetchThread(action.threadId));
            return;
          }
          case "load": {
            await adoptThread(await fetchThread(action.threadId));
            return;
          }
          case "create": {
            const rawThread: unknown = await api(ASSISTANT_THREADS_PATH, {
              method: "POST",
              body: buildAssistantTurnRequest(
                action.requestId,
                action.model,
                action.effort,
                action.serviceTier,
                action.content,
              ),
              signal: controller.signal,
            });
            const thread = assistantThreadSchema.parse(rawThread);
            skipHydrationThreadIdRef.current = thread.id;
            setActiveThread(thread);
            setPendingUser(null);
            suppressedRouteLoadRef.current = thread.id;
            navigate(`/admin/assistant/${thread.id}`, { replace: true });
            await refreshThreadList();
            const turn = thread.turns.at(-1);
            if (turn) await watchTurn(thread.id, turn);
            else setPhase("idle");
            return;
          }
          case "append": {
            const rawTurn: unknown = await api(
              `${ASSISTANT_THREADS_PATH}/${action.threadId}/turns`,
              {
                method: "POST",
                body: buildAssistantTurnRequest(
                  action.requestId,
                  action.model,
                  action.effort,
                  action.serviceTier,
                  action.content,
                ),
                signal: controller.signal,
              },
            );
            const turn = assistantTurnSchema.parse(rawTurn);
            setActiveThread((current) =>
              current?.id === action.threadId
                ? replaceOrAppendTurn(current, turn)
                : current,
            );
            setPendingUser(null);
            await watchTurn(action.threadId, turn);
            return;
          }
          case "poll": {
            const rawTurn: unknown = await api(
              turnPath(action.threadId, action.turnId),
              { signal: controller.signal },
            );
            await watchTurn(
              action.threadId,
              assistantTurnSchema.parse(rawTurn),
            );
            return;
          }
          case "retry": {
            const rawTurn: unknown = await api(
              `${turnPath(action.threadId, action.turnId)}/retry`,
              {
                method: "POST",
                signal: controller.signal,
              },
            );
            const turn = assistantTurnSchema.parse(rawTurn);
            setActiveThread((current) =>
              current?.id === action.threadId
                ? replaceOrAppendTurn(current, turn)
                : current,
            );
            await watchTurn(action.threadId, turn);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;

        const status = responseStatus(error);
        const selectedRecovery =
          status === 409 &&
          "threadId" in recoveryAction &&
          typeof recoveryAction.threadId === "string"
            ? ({ kind: "load", threadId: recoveryAction.threadId } as const)
            : recoveryAction;
        const submission =
          recoveryAction.kind === "create" || recoveryAction.kind === "append"
            ? recoveryAction
            : null;
        setPhase("idle");
        setAnnouncement("Assistant request needs attention.");
        setFailure({
          kind: submission ? "submission" : "recovery",
          message: requestFailureMessage(status),
          action: selectedRecovery,
          retryLabel: status === 409 ? "Reload conversation" : "Try again",
          revision: submission
            ? {
                requestId: submission.requestId,
                model: submission.model,
                effort: submission.effort,
                serviceTier: submission.serviceTier,
                content: submission.content,
              }
            : null,
        });
      } finally {
        if (operationRef.current === controller) {
          operationRef.current = null;
        }
      }
    },
    [focusComposer, navigate],
  );

  useEffect(() => {
    if (
      suppressedRouteLoadRef.current !== undefined &&
      suppressedRouteLoadRef.current === routeThreadId
    ) {
      suppressedRouteLoadRef.current = undefined;
      return;
    }

    if (operationRef.current) {
      operationRef.current.abort();
      operationRef.current = null;
    }

    const timeoutId = window.setTimeout(() => {
      void executeAction({ kind: "initial", threadId: routeThreadId ?? null });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [executeAction, routeThreadId]);

  useEffect(() => () => operationRef.current?.abort(), []);

  const messages = useMemo(() => {
    const persisted = messagesFromThread(
      overlayAssistantLiveTurn(activeThread, liveTurn),
    );
    if (!pendingUser) return persisted;
    if (
      activeThread?.turns.some(
        (turn) => turn.requestId === pendingUser.requestId,
      )
    ) {
      return persisted;
    }

    const optimistic: AssistantDisplayMessage = {
      id: `${pendingUser.requestId}-user`,
      turnId: pendingUser.requestId,
      role: "user",
      content: pendingUser.content,
      model: pendingUser.model,
      effort: pendingUser.effort,
      serviceTier: pendingUser.serviceTier,
      reasoning: null,
      toolCalls: [],
      usage: null,
      status: "queued",
    };
    return [...persisted, optimistic];
  }, [activeThread, liveTurn, pendingUser]);

  const latestUserMessageId = useMemo(
    () =>
      [...messages].reverse().find((message) => message.role === "user")?.id,
    [messages],
  );
  const activeThreadId = activeThread?.id;

  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    const composer = composerContainerRef.current;
    const userMessage = latestUserMessageId
      ? document.getElementById(latestUserMessageId)
      : null;
    if (!scroller || !composer) {
      setReplyMinHeight(null);
      return;
    }

    const measure = () => {
      const scrollerBounds = scroller.getBoundingClientRect();
      const composerBounds = composer.getBoundingClientRect();
      const visibleBottom = Math.min(
        scrollerBounds.bottom,
        Math.max(scrollerBounds.top, composerBounds.top),
      );
      const visibleHeight = visibleBottom - scrollerBounds.top;
      const bottomClearance = Math.ceil(
        Math.max(scrollerBounds.bottom - visibleBottom + 24, 24),
      );
      setConversationBottomClearance((current) =>
        current === bottomClearance ? current : bottomClearance,
      );

      if (!userMessage) {
        setReplyMinHeight(null);
        return;
      }
      const userContent = userMessage.querySelector<HTMLElement>(
        "[data-assistant-user-content]",
      );
      const userHeight = (userContent ?? userMessage).getBoundingClientRect()
        .height;
      const next = calculateAssistantReplyMinHeight(visibleHeight, userHeight);
      setReplyMinHeight((current) =>
        current !== null && Math.abs(current - next) < 0.5 ? current : next,
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(composer);
    if (userMessage) observer.observe(userMessage);
    return () => observer.disconnect();
  }, [latestUserMessageId]);

  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller || replyMinHeight === null) return;

    if (alignLatestQuestionRef.current && isBusy) {
      const element = latestUserMessageId
        ? document.getElementById(latestUserMessageId)
        : null;
      if (element) {
        const questionContent =
          element.querySelector<HTMLElement>("[data-assistant-user-content]") ??
          element;
        const targetScrollTop = calculateAssistantQuestionScrollTop(
          scroller.scrollTop,
          questionContent.getBoundingClientRect().top,
          scroller.getBoundingClientRect().top,
        );
        const alignQuestion = () =>
          scroller.scrollTo({ top: targetScrollTop, behavior: "smooth" });

        alignQuestion();
        const frame = window.requestAnimationFrame(() => {
          alignQuestion();
          if (activeThreadId) {
            alignLatestQuestionRef.current = false;
            previousThreadIdRef.current = activeThreadId;
          }
        });
        return () => window.cancelAnimationFrame(frame);
      }
    }
  }, [activeThreadId, isBusy, latestUserMessageId, replyMinHeight]);

  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller || !activeThreadId) return;
    if (activeThreadId === previousThreadIdRef.current) return;

    if (skipHydrationThreadIdRef.current === activeThreadId) {
      skipHydrationThreadIdRef.current = null;
      previousThreadIdRef.current = activeThreadId;
      return;
    }

    previousThreadIdRef.current = activeThreadId;
    const scrollToBottom = () => {
      scroller.scrollTop = scroller.scrollHeight;
    };

    // Match notes_ai hydration: land immediately, confirm one frame later, and
    // absorb short-lived Markdown/Mermaid/layout growth without visible jumps.
    scrollToBottom();
    const frame = window.requestAnimationFrame(scrollToBottom);
    const content = scroller.firstElementChild;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scrollToBottom);
    observer?.observe(scroller);
    if (content) observer?.observe(content);
    const timeoutId = window.setTimeout(() => observer?.disconnect(), 1_000);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeoutId);
      observer?.disconnect();
    };
  }, [activeThreadId]);

  function changeModel(model: AssistantModel): void {
    setSelectedModel(model);
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
      // The selection still works for this tab if storage is unavailable.
    }
  }

  function changeEffort(effort: AssistantEffort): void {
    setSelectedEffort(effort);
    try {
      localStorage.setItem(EFFORT_STORAGE_KEY, effort);
    } catch {
      // The selection still works for this tab if storage is unavailable.
    }
  }

  function changeServiceTier(tier: AssistantServiceTier): void {
    setSelectedServiceTier(tier);
    try {
      localStorage.setItem(SERVICE_TIER_STORAGE_KEY, tier);
    } catch {
      // The selection still works for this tab if storage is unavailable.
    }
  }

  function submitMessage(): void {
    // State updates lag one render; the ref closes the double-submit window
    // before optimistic UI or composer state is mutated.
    if (operationRef.current || isBusy || failure) return;

    const content = composer.trim();
    if (!content) {
      setComposerError("Write a message before sending.");
      textareaRef.current?.focus();
      return;
    }

    const requestId = crypto.randomUUID();
    setPendingUser({
      requestId,
      model: selectedModel,
      effort: selectedEffort,
      serviceTier: selectedServiceTier,
      content,
    });
    setComposer("");
    setComposerError(null);
    setAnnouncement("Message sent. Assistant generation queued.");
    alignLatestQuestionRef.current = true;

    if (activeThread) {
      void executeAction({
        kind: "append",
        threadId: activeThread.id,
        requestId,
        model: selectedModel,
        effort: selectedEffort,
        serviceTier: selectedServiceTier,
        content,
      });
    } else {
      void executeAction({
        kind: "create",
        requestId,
        model: selectedModel,
        effort: selectedEffort,
        serviceTier: selectedServiceTier,
        content,
      });
    }
  }

  function startNewConversation(): void {
    if (operationRef.current || isBusy) return;
    setActiveThread(null);
    setPendingUser(null);
    setFailure(null);
    setPhase("idle");
    setComposer("");
    setComposerError(null);
    setAnnouncement("New conversation ready.");
    skipHydrationThreadIdRef.current = null;
    previousThreadIdRef.current = null;
    navigate("/admin/assistant");
    focusComposer();
  }

  function reviseFailure(): void {
    if (operationRef.current || !failure?.revision) return;

    const revision = failure.revision;
    // A durable failed turn remains immutable, but its thread is no longer
    // active. Keep that thread selected so the revised draft appends as a new
    // turn and retains the earlier successful context; only a failed initial
    // create has no durable thread to continue.
    const requiresNewThread = failure.action.kind === "create";

    if (requiresNewThread) {
      setActiveThread(null);
      previousThreadIdRef.current = null;
      navigate("/admin/assistant");
    }

    setPendingUser(null);
    setFailure(null);
    setPhase("idle");
    setComposer(revision.content);
    setComposerError(null);
    changeModel(revision.model);
    changeEffort(revision.effort);
    changeServiceTier(revision.serviceTier);
    setAnnouncement(
      "Draft restored. Revise it or change model settings before sending a new request.",
    );
    focusComposer();
  }

  function selectThread(key: string | number | null): void {
    if (key === null) return;
    if (key === NEW_THREAD_KEY) {
      startNewConversation();
      return;
    }
    if (typeof key === "string") {
      if (key === activeThread?.id) return;
      setFailure(null);
      setPhase("loading");
      skipHydrationThreadIdRef.current = null;
      previousThreadIdRef.current = null;
      navigate(`/admin/assistant/${key}`);
    }
  }

  return (
    <section
      aria-labelledby="assistant-conversation-heading"
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"
    >
      <h1 id="assistant-conversation-heading" className="sr-only">
        AI assistant
      </h1>

      <div className="z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
        <Select
          aria-label="Open a recent assistant conversation"
          selectedKey={routeThreadId ?? NEW_THREAD_KEY}
          isDisabled={isBusy}
          onSelectionChange={selectThread}
          className="min-w-0 flex-1 sm:max-w-sm"
        >
          <Select.Trigger className="w-full">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={NEW_THREAD_KEY} textValue="New conversation">
                <span className="font-semibold text-ink">New conversation</span>
              </ListBox.Item>
              {threads.map((thread) => (
                <ListBox.Item
                  key={thread.id}
                  id={thread.id}
                  textValue={thread.title}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate text-sm font-semibold text-ink">
                      {thread.title}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {formatDateTime(thread.updatedAt)}
                    </span>
                  </span>
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <div className="flex items-center gap-1.5">
          <Chip
            variant="tertiary"
            className={clsx(
              "rounded-sm border px-2 py-1 text-[0.625rem] font-extrabold uppercase tracking-[0.06em]",
              failure
                ? "border-danger/35 bg-danger-soft text-danger"
                : isBusy
                  ? "border-primary-border bg-primary-soft text-primary"
                  : "border-success/35 bg-success-soft text-success",
            )}
          >
            {phaseLabel(phase)}
          </Chip>
          {activeThread ? (
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              isDisabled={isBusy}
              aria-label="New conversation"
              onPress={startNewConversation}
            >
              <MessageSquarePlus aria-hidden="true" className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <ScrollShadow
        ref={scrollContainerRef}
        role="region"
        aria-label="Assistant conversation history"
        tabIndex={0}
        orientation="vertical"
        // Always-on gutter, like the source: an appearing scrollbar would
        // otherwise recentre the column while the docked composer stays put.
        className="min-h-0 flex-1 overflow-y-scroll bg-surface [overflow-anchor:none] focus-visible:-outline-offset-2"
      >
        <AssistantConversation
          messages={messages}
          phase={phase}
          failureMessage={failure?.message ?? null}
          canRetryFailure={failure !== null}
          retryLabel={failure?.retryLabel ?? "Try again"}
          startNewLabel={
            failure?.kind === "submission" ? "Discard & start new" : "Start new"
          }
          announcement={announcement}
          replyMinHeight={replyMinHeight}
          bottomClearance={conversationBottomClearance}
          onRetryFailure={() => {
            if (failure) void executeAction(failure.action);
          }}
          onReviseFailure={failure?.revision ? reviseFailure : null}
          onStartNew={startNewConversation}
          onStarter={(prompt) => {
            setComposer(prompt);
            setComposerError(null);
            focusComposer();
          }}
        />
      </ScrollShadow>

      <AssistantComposer
        value={composer}
        selectedModel={selectedModel}
        selectedEffort={selectedEffort}
        selectedServiceTier={selectedServiceTier}
        isBusy={isBusy}
        isBlocked={failure !== null}
        error={composerError}
        containerRef={composerContainerRef}
        textareaRef={textareaRef}
        onChange={(value) => {
          setComposer(value);
          if (composerError) setComposerError(null);
        }}
        onModelChange={changeModel}
        onEffortChange={changeEffort}
        onServiceTierChange={changeServiceTier}
        onSubmit={submitMessage}
      />
    </section>
  );
}
