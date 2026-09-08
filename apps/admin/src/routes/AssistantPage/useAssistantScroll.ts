import { useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import {
  calculateAssistantQuestionScrollTop,
  calculateAssistantReplyMinHeight,
} from "../../features/assistant/layout";

export function useAssistantScroll({
  activeThreadId,
  latestUserMessageId,
  isBusy,
  alignment,
}: {
  activeThreadId: string | undefined;
  latestUserMessageId: string | undefined;
  isBusy: boolean;
  alignment: ReturnType<typeof useAssistantAlignment>;
}) {
  const {
    alignLatestQuestionRef,
    skipHydrationThreadIdRef,
    previousThreadIdRef,
  } = alignment;

  const [replyMinHeight, setReplyMinHeight] = useState<number | null>(null);

  const [conversationBottomClearance, setConversationBottomClearance] =
    useState(160);

  const composerContainerRef = useRef<HTMLFormElement>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
  }, [
    activeThreadId,
    isBusy,
    latestUserMessageId,
    replyMinHeight,
    alignLatestQuestionRef,
    previousThreadIdRef,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    if (
      !scroller ||
      !activeThreadId ||
      !latestUserMessageId ||
      replyMinHeight === null
    ) {
      return;
    }
    if (activeThreadId === previousThreadIdRef.current) return;

    if (skipHydrationThreadIdRef.current === activeThreadId) {
      skipHydrationThreadIdRef.current = null;
      previousThreadIdRef.current = activeThreadId;
      return;
    }

    previousThreadIdRef.current = activeThreadId;
    const latestQuestion = document.getElementById(latestUserMessageId);
    if (!latestQuestion) return;
    const questionContent =
      latestQuestion.querySelector<HTMLElement>(
        "[data-assistant-user-content]",
      ) ?? latestQuestion;
    const alignLatestQuestion = () => {
      scroller.scrollTop = calculateAssistantQuestionScrollTop(
        scroller.scrollTop,
        questionContent.getBoundingClientRect().top,
        scroller.getBoundingClientRect().top,
      );
    };

    // Reload and thread selection must restore the same question-aligned layout
    // as a live send. Bottom-locking here made the final question disappear
    // above the viewport once the answer reserve was measured.
    alignLatestQuestion();
    const frame = window.requestAnimationFrame(alignLatestQuestion);
    const content = scroller.firstElementChild;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(alignLatestQuestion);
    observer?.observe(scroller);
    if (content) observer?.observe(content);
    const timeoutId = window.setTimeout(() => observer?.disconnect(), 1_000);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeoutId);
      observer?.disconnect();
    };
  }, [
    activeThreadId,
    latestUserMessageId,
    replyMinHeight,
    previousThreadIdRef,
    skipHydrationThreadIdRef,
  ]);
  return {
    replyMinHeight,
    conversationBottomClearance,
    composerContainerRef,
    scrollContainerRef,
  };
}

export function useAssistantAlignment(routeThreadId: string | undefined) {
  const location = useLocation();

  const preserveLiveAlignment =
    (
      location.state as {
        preserveAssistantLiveAlignment?: boolean;
      } | null
    )?.preserveAssistantLiveAlignment === true;

  const alignLatestQuestionRef = useRef(preserveLiveAlignment);

  const skipHydrationThreadIdRef = useRef<string | null>(
    preserveLiveAlignment ? (routeThreadId ?? null) : null,
  );

  const previousThreadIdRef = useRef<string | null>(null);
  return {
    alignLatestQuestionRef,
    skipHydrationThreadIdRef,
    previousThreadIdRef,
  };
}
