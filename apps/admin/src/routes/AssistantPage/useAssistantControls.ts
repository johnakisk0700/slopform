import { useCallback, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
  EFFORT_STORAGE_KEY,
  MODEL_STORAGE_KEY,
  SERVICE_TIER_STORAGE_KEY,
  readSavedEffort,
  readSavedModel,
  readSavedServiceTier,
} from "../../features/assistant/composerSettings";
import {
  ASSISTANT_MESSAGE_MAX_LENGTH,
  type AssistantDisplayMessage,
  type AssistantEffort,
  type AssistantModel,
  type AssistantServiceTier,
} from "../../features/assistant/schema";

import {
  useAssistantAlignment,
  useAssistantScroll,
} from "./useAssistantScroll";
import {
  useAssistantSession,
  type PendingUserMessage,
} from "./useAssistantSession";

export const NEW_THREAD_KEY = "new";

export function useAssistantControls() {
  const navigate = useNavigate();
  const { threadId: routeThreadId } = useParams<{ threadId?: string }>();
  const alignment = useAssistantAlignment(routeThreadId);
  const {
    alignLatestQuestionRef,
    skipHydrationThreadIdRef,
    previousThreadIdRef,
  } = alignment;

  const [composer, setComposer] = useState("");

  const [composerError, setComposerError] = useState<string | null>(null);
  const {
    selectedModel,
    selectedEffort,
    selectedServiceTier,
    changeModel,
    changeEffort,
    changeServiceTier,
  } = useAssistantSettings();

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  const {
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
  } = useAssistantSession(routeThreadId, focusComposer, alignment);
  const {
    replyMinHeight,
    conversationBottomClearance,
    composerContainerRef,
    scrollContainerRef,
  } = useAssistantScroll({
    activeThreadId,
    latestUserMessageId,
    isBusy,
    alignment,
  });

  const branchFromMessage = useCallback(
    (message: AssistantDisplayMessage, content: string): void => {
      if (operationRef.current || isBusy || !activeThreadId) return;
      const editedContent = content.trim();
      if (!editedContent || editedContent.length > ASSISTANT_MESSAGE_MAX_LENGTH)
        return;

      setFailure(null);
      setComposerError(null);
      setAnnouncement("Creating a new conversation from the selected message.");
      void executeAction({
        kind: "branch",
        threadId: activeThreadId,
        sourceTurnId: message.turnId,
        request: {
          requestId: crypto.randomUUID(),
          model: selectedModel,
          effort: selectedEffort,
          serviceTier: selectedServiceTier,
          content: editedContent,
        },
      });
    },
    [
      activeThreadId,
      executeAction,
      isBusy,
      operationRef,
      setAnnouncement,
      setFailure,
      selectedEffort,
      selectedModel,
      selectedServiceTier,
    ],
  );

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

    if (content.length > ASSISTANT_MESSAGE_MAX_LENGTH) {
      setComposerError("Keep your message within 20,000 characters.");
      textareaRef.current?.focus();
      return;
    }

    const request: PendingUserMessage = {
      requestId: crypto.randomUUID(),
      model: selectedModel,
      effort: selectedEffort,
      serviceTier: selectedServiceTier,
      content,
    };
    setPendingUser(request);
    setComposer("");
    setComposerError(null);
    setAnnouncement("Message sent. Assistant generation queued.");
    alignLatestQuestionRef.current = true;

    void executeAction(
      activeThread
        ? { kind: "append", threadId: activeThread.id, request }
        : { kind: "create", request },
    );
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
  return {
    routeThreadId,
    threads,
    activeThread,
    composer,
    setComposer,
    composerError,
    setComposerError,
    selectedModel,
    selectedEffort,
    selectedServiceTier,
    phase,
    failure,
    announcement,
    replyMinHeight,
    conversationBottomClearance,
    textareaRef,
    composerContainerRef,
    scrollContainerRef,
    isBusy,
    isGenerating,
    focusComposer,
    executeAction,
    messages,
    branchFromMessage,
    changeModel,
    changeEffort,
    changeServiceTier,
    submitMessage,
    startNewConversation,
    reviseFailure,
    selectThread,
  };
}

function useAssistantSettings() {
  const [selectedModel, setSelectedModel] =
    useState<AssistantModel>(readSavedModel);

  const [selectedEffort, setSelectedEffort] =
    useState<AssistantEffort>(readSavedEffort);

  const [selectedServiceTier, setSelectedServiceTier] =
    useState<AssistantServiceTier>(readSavedServiceTier);

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
  return {
    selectedModel,
    selectedEffort,
    selectedServiceTier,
    changeModel,
    changeEffort,
    changeServiceTier,
  };
}
