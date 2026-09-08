import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import type { AssistantThreadListDtoOutput } from "../../api/generated/model/assistantThreadListDtoOutput";
import type { CreateAssistantTurnDto } from "../../api/generated/model/createAssistantTurnDto";
import {
  requestFailureMessage,
  responseStatus,
} from "../../features/assistant/failureMessages";
import {
  assistantFailureMessage,
  messagesFromThread,
  type AssistantDisplayMessage,
  type AssistantThread,
  type AssistantThreadSummary,
  type AssistantTurn,
  type AssistantTurnStatus,
} from "../../features/assistant/schema";
import {
  overlayAssistantLiveTurn,
  reduceAssistantLiveTurn,
  type AssistantLiveTurn,
} from "../../features/assistant/stream";
import { api } from "../../lib/api";

import {
  ASSISTANT_THREADS_PATH,
  turnPath,
  waitForNextPoll,
  watchAssistantStream,
} from "./assistantTransport";
import type { useAssistantAlignment } from "./useAssistantScroll";

export function useAssistantSession(
  routeThreadId: string | undefined,
  focusComposer: () => void,
  alignment: ReturnType<typeof useAssistantAlignment>,
) {
  const navigate = useNavigate();
  const { alignLatestQuestionRef, skipHydrationThreadIdRef } = alignment;

  const [threads, setThreads] = useState<AssistantThreadSummary[]>([]);

  const [activeThread, setActiveThread] = useState<AssistantThread | null>(
    null,
  );

  const [liveTurn, setLiveTurn] = useState<AssistantLiveTurn | null>(null);

  const [pendingUser, setPendingUser] = useState<PendingUserMessage | null>(
    null,
  );

  const [phase, setPhase] = useState<PagePhase>("loading");

  const [failure, setFailure] = useState<PageFailure | null>(null);

  const [announcement, setAnnouncement] = useState("");

  const operationRef = useRef<AbortController | null>(null);

  const suppressedRouteLoadRef = useRef<string | undefined>(undefined);

  const isBusy =
    phase === "loading" ||
    phase === "submitting" ||
    phase === "queued" ||
    phase === "running";

  const isGenerating =
    phase === "submitting" || phase === "queued" || phase === "running";

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
        return api<AssistantThread>(`${ASSISTANT_THREADS_PATH}/${threadId}`, {
          signal: controller.signal,
        });
      }

      async function refreshThreadList(): Promise<void> {
        const list = await api<AssistantThreadListDtoOutput>(
          ASSISTANT_THREADS_PATH,
          {
            signal: controller.signal,
          },
        );
        setThreads(list.items);
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

            turn = await api<AssistantTurn>(turnPath(threadId, turn.id), {
              signal: controller.signal,
            });
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
            setFailure(buildFailedTurnRecovery(threadId, turn));
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
          setFailure(buildFailedTurnRecovery(thread.id, lastTurn));
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
          case "create":
          case "branch": {
            const branching = action.kind === "branch";
            const thread = await api<AssistantThread>(
              branching
                ? `${ASSISTANT_THREADS_PATH}/${action.threadId}/branches`
                : ASSISTANT_THREADS_PATH,
              {
                method: "POST",
                body: branching
                  ? { ...action.request, sourceTurnId: action.sourceTurnId }
                  : action.request,
                signal: controller.signal,
              },
            );
            skipHydrationThreadIdRef.current = thread.id;
            if (branching) alignLatestQuestionRef.current = true;
            setActiveThread(thread);
            setPendingUser(null);
            suppressedRouteLoadRef.current = thread.id;
            navigate(`/admin/assistant/${thread.id}`, {
              replace: true,
              state: { preserveAssistantLiveAlignment: true },
            });
            await refreshThreadList();
            const turn = thread.turns.at(-1);
            if (turn) await watchTurn(thread.id, turn);
            else setPhase("idle");
            return;
          }
          case "append": {
            const turn = await api<AssistantTurn>(
              `${ASSISTANT_THREADS_PATH}/${action.threadId}/turns`,
              {
                method: "POST",
                body: action.request,
                signal: controller.signal,
              },
            );
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
            const turn = await api<AssistantTurn>(
              turnPath(action.threadId, action.turnId),
              { signal: controller.signal },
            );
            await watchTurn(action.threadId, turn);
            return;
          }
          case "retry": {
            const turn = await api<AssistantTurn>(
              `${turnPath(action.threadId, action.turnId)}/retry`,
              {
                method: "POST",
                signal: controller.signal,
              },
            );
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
          recoveryAction.kind === "create" ||
          recoveryAction.kind === "append" ||
          recoveryAction.kind === "branch"
            ? recoveryAction
            : null;
        setPhase("idle");
        setAnnouncement("Assistant request needs attention.");
        setFailure({
          kind: submission ? "submission" : "recovery",
          message: requestFailureMessage(status),
          action: selectedRecovery,
          retryLabel: status === 409 ? "Reload conversation" : "Try again",
          revision:
            submission && submission.kind !== "branch"
              ? submission.request
              : null,
        });
      } finally {
        if (operationRef.current === controller) {
          operationRef.current = null;
        }
      }
    },
    [focusComposer, navigate, alignLatestQuestionRef, skipHydrationThreadIdRef],
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

  const latestUserMessageId = messages.findLast(
    (message) => message.role === "user",
  )?.id;

  const activeThreadId = activeThread?.id;
  return {
    threads,
    activeThread,
    setActiveThread,
    setPendingUser,
    phase,
    setPhase,
    failure,
    setFailure,
    announcement,
    setAnnouncement,
    operationRef,
    isBusy,
    isGenerating,
    executeAction,
    messages,
    latestUserMessageId,
    activeThreadId,
  };
}

type PagePhase = "loading" | "idle" | "submitting" | AssistantTurnStatus;

type AssistantAction =
  | { kind: "initial"; threadId: string | null }
  | { kind: "load"; threadId: string }
  | { kind: "create"; request: PendingUserMessage }
  | { kind: "append"; threadId: string; request: PendingUserMessage }
  | {
      kind: "branch";
      threadId: string;
      sourceTurnId: string;
      request: PendingUserMessage;
    }
  | { kind: "poll"; threadId: string; turnId: string }
  | { kind: "retry"; threadId: string; turnId: string };

export interface PageFailure {
  kind: "submission" | "durable" | "recovery";
  message: string;
  action: AssistantAction;
  retryLabel: string;
  revision: PendingUserMessage | null;
}

export type PendingUserMessage = Required<CreateAssistantTurnDto>;

function buildFailedTurnRecovery(
  threadId: string,
  turn: AssistantTurn,
): PageFailure {
  return {
    kind: "durable",
    message: assistantFailureMessage(turn.error?.code ?? "generation_failed"),
    action: { kind: "retry", threadId, turnId: turn.id },
    retryLabel: "Retry turn",
    revision: {
      requestId: turn.requestId,
      model: turn.model,
      effort: turn.effort,
      serviceTier: turn.serviceTier,
      content: turn.user.content,
    },
  };
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
