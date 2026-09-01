import { useEffect } from "react";

const SITE_NAME = "Slopform";

/**
 * Sets the document title and meta description for the current view.
 *
 * The title renders as `"<title> · Slopform"`, collapsing to the bare
 * site name when `title` is empty. `robots` is declared globally in
 * `index.html`, so this hook never touches it.
 *
 * This is a single-page app, so cleanup is unnecessary: whichever view mounts
 * last wins, and every routed view sets its own meta. Passing `undefined` for
 * `description` leaves any existing description untouched.
 */
export function usePageMeta(title: string, description?: string): void {
  useEffect(() => {
    const trimmed = title.trim();
    document.title = trimmed ? `${trimmed} · ${SITE_NAME}` : SITE_NAME;

    if (description === undefined) return;

    let meta = document.head.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.content = description;
  }, [title, description]);
}
