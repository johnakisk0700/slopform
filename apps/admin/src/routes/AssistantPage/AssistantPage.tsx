import { Button, ListBox, Select } from "@heroui/react";
import { MessageSquarePlus } from "lucide-react";

import { AssistantComposer } from "../../components/admin/assistant/AssistantComposer";
import { AssistantConversation } from "../../components/admin/assistant/AssistantConversation";
import { formatDateTime } from "../../lib/dateTime";
import { usePageMeta } from "../../lib/usePageMeta";

import { NEW_THREAD_KEY, useAssistantControls } from "./useAssistantControls";

export function AssistantPage() {
  const {
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
  } = useAssistantControls();

  usePageMeta(
    "AI assistant",
    "Durable AI conversations for Slopform event operations.",
  );

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
          <Select.Trigger className="w-full overflow-hidden">
            <Select.Value className="min-w-0 flex-1 truncate text-left">
              {({ selectedText }) => selectedText}
            </Select.Value>
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

      <div
        ref={scrollContainerRef}
        role="region"
        aria-label="Assistant conversation history"
        // Always-on gutter, like the source: an appearing scrollbar would
        // otherwise recentre the column while the docked composer stays put.
        className="min-h-0 flex-1 overflow-y-scroll bg-surface [overflow-anchor:none]"
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
          onBranchMessage={branchFromMessage}
          isBranchDisabled={isBusy}
          onStarter={(prompt) => {
            setComposer(prompt);
            setComposerError(null);
            focusComposer();
          }}
        />
      </div>

      <AssistantComposer
        value={composer}
        selectedModel={selectedModel}
        selectedEffort={selectedEffort}
        selectedServiceTier={selectedServiceTier}
        isBusy={isGenerating}
        isLoading={phase === "loading"}
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
