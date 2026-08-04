import { transcriptMessageAnchorId } from "./conversationView";

/** One-shot class the flash keyframes in `globals.css` listen for. */
export const TRANSCRIPT_MESSAGE_FLASH_CLASS = "jts-message-flash";

/**
 * Breathing room between the viewport top and the transcript pane when we pin
 * it. Flush-to-top felt cramped under the admin chrome.
 */
const PANE_TOP_INSET_PX = 16;

/** How far the pane may sit from that inset before we bother pinning. */
const PANE_PIN_SLACK_PX = 48;

/** Fallback if `scrollend` never fires (no movement, or older engines). */
const FLASH_FALLBACK_MS = 450;

/**
 * Sends the operator to the transcript message an attention reason cites —
 * without yanking the document around the message itself.
 *
 * `scrollIntoView` on the message walks every scrollable ancestor and used to
 * move the page on every press. The transcript already forbids that for
 * follow-bottom; this is the same rule for the attention link: pin the pane
 * with a little air under the viewport top if it has drifted, smooth-scroll
 * only inside the messages box, then flash the bubble and move focus there.
 */
export function revealTranscriptMessage(messageId: string): void {
  const element = document.getElementById(transcriptMessageAnchorId(messageId));
  if (!(element instanceof HTMLElement)) {
    return;
  }

  const pane = element.closest("[data-transcript-pane]");
  const scroller = element.closest("[data-transcript-scroller]");
  if (!(scroller instanceof HTMLElement)) {
    return;
  }

  if (pane instanceof HTMLElement) {
    pinPaneWithInset(pane);
  }

  const distance = scrollScrollerToCenter(scroller, element);
  // Focus follows the scroll so the keyboard and a screen reader land on the
  // message too, rather than only the sighted operator's eye. preventScroll
  // keeps focus from fighting the smooth scroll we just started.
  element.focus({ preventScroll: true });

  if (distance < 1) {
    flashMessage(element);
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    scroller.removeEventListener("scrollend", finish);
    window.clearTimeout(fallback);
    flashMessage(element);
  };

  scroller.addEventListener("scrollend", finish, { once: true });
  const fallback = window.setTimeout(finish, FLASH_FALLBACK_MS);
}

function pinPaneWithInset(pane: HTMLElement): void {
  const top = pane.getBoundingClientRect().top;
  if (Math.abs(top - PANE_TOP_INSET_PX) <= PANE_PIN_SLACK_PX) {
    return;
  }
  // Document scroll only — never ask the message to scrollIntoView. Leave the
  // inset so the whole chat breathes under the page chrome instead of kissing
  // the viewport edge.
  const nextTop = window.scrollY + top - PANE_TOP_INSET_PX;
  window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
}

/**
 * Returns the absolute distance scrolled (px). Zero means the message was
 * already centred enough that we can flash immediately.
 */
function scrollScrollerToCenter(
  scroller: HTMLElement,
  element: HTMLElement,
): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const elementCenter =
    elementRect.top -
    scrollerRect.top +
    scroller.scrollTop +
    elementRect.height / 2;
  const targetTop = elementCenter - scroller.clientHeight / 2;
  const nextTop = Math.max(
    0,
    Math.min(targetTop, scroller.scrollHeight - scroller.clientHeight),
  );
  const distance = Math.abs(nextTop - scroller.scrollTop);
  if (distance < 1) {
    return 0;
  }
  scroller.scrollTo({ top: nextTop, behavior: "smooth" });
  return distance;
}

function flashMessage(element: HTMLElement): void {
  element.classList.remove(TRANSCRIPT_MESSAGE_FLASH_CLASS);
  // Force a reflow so re-clicking the same reason restarts the keyframes.
  void element.offsetWidth;
  element.classList.add(TRANSCRIPT_MESSAGE_FLASH_CLASS);

  let cleared = false;
  const clear = () => {
    if (cleared) {
      return;
    }
    cleared = true;
    element.classList.remove(TRANSCRIPT_MESSAGE_FLASH_CLASS);
    element.removeEventListener("animationend", clear);
    window.clearTimeout(fallback);
  };
  element.addEventListener("animationend", clear);
  // Reduced-motion path has no animationend — clear the static tint ourselves.
  const fallback = window.setTimeout(clear, 1600);
}
