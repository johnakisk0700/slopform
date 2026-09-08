import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import {
  hasExplicitConversationSelection,
  resolveSelectedConversationId,
  type ConversationListItem,
} from "../../features/feedback/conversationView";

export function useConversationSelection(
  visible: readonly ConversationListItem[],
  setActionError: (error: string | null) => void,
) {
  const [searchParams, setSearchParams] = useSearchParams();

  const requestedId = searchParams.get("conversation");

  // Keep desktop auto-selection stable across polls without opening mobile detail.
  const [stickySelectedId, setStickySelectedId] = useState<string | null>(null);

  const selectedId = resolveSelectedConversationId(
    visible,
    requestedId,
    stickySelectedId,
  );

  if (stickySelectedId !== selectedId) {
    setStickySelectedId(selectedId);
  }

  // Only a valid explicit URL selection opens the narrow detail view.
  const threadOpenOnNarrow = hasExplicitConversationSelection(
    requestedId,
    selectedId,
  );

  // Push the cover on open; replace on close so Back exits it before the thread.
  const fullscreenOnNarrow =
    threadOpenOnNarrow && searchParams.get("fullscreen") === "1";

  function selectConversation(conversationId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("conversation", conversationId);
    next.delete("fullscreen");
    // Opening the *first* thread is a step into a detail view — on a phone the
    // whole screen changes, so the back gesture has to undo it. Switching
    // between threads is not a step: that replaces, or an operator clicking
    // down the list on a wide screen buries the way out under ten entries.
    setSearchParams(next, { replace: threadOpenOnNarrow });
    setActionError(null);
  }

  const setConversationFullscreen = useCallback(
    (open: boolean) => {
      const next = new URLSearchParams(searchParams);
      if ((next.get("fullscreen") === "1") === open) {
        return;
      }
      if (open) {
        next.set("fullscreen", "1");
      } else {
        next.delete("fullscreen");
      }
      setSearchParams(next, { replace: !open });
    },
    [searchParams, setSearchParams],
  );

  // The cover is a phone affordance. A wide layout with `?fullscreen=1` left
  // in the URL (rotate, paste) must not keep a scroll-locked fixed pane.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 64rem)");
    function dropFullscreenOnDesktop() {
      if (desktop.matches) {
        setConversationFullscreen(false);
      }
    }
    dropFullscreenOnDesktop();
    desktop.addEventListener("change", dropFullscreenOnDesktop);
    return () => desktop.removeEventListener("change", dropFullscreenOnDesktop);
  }, [setConversationFullscreen]);
  return {
    selectedId,
    threadOpenOnNarrow,
    fullscreenOnNarrow,
    selectConversation,
    setConversationFullscreen,
  };
}
