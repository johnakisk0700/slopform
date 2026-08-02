import type { FeedbackOutboxHistoryCursor } from "./outbox.repository.js";

/**
 * The cursor an operator's «older» button carries, as one opaque string.
 *
 * It is `created_at` and `id` — exactly the two columns the history is ordered
 * by — base64url-encoded so it reads as a token rather than as two parameters
 * a caller might be tempted to compose by hand. That opacity is the contract:
 * the sort key is free to gain a column without every stored link breaking,
 * and nobody can hand-craft a cursor that walks an order the query does not
 * have.
 *
 * Base64url, not base64: this value travels in a query string, where `+` is a
 * space and `/` starts a path segment.
 */
const SEPARATOR = "|";

export function encodeOutboxHistoryCursor(
  cursor: FeedbackOutboxHistoryCursor,
): string {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}${SEPARATOR}${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

/**
 * The cursor back, or `null` when it is anything other than one we wrote.
 *
 * Null rather than a throw, and the caller starts from the newest row again. A
 * cursor arrives from a URL an operator may have edited, truncated in a chat
 * message or kept across a deploy; none of those is an error worth a 400 on a
 * read-only log viewer, and «you are back at the top» is a state the screen can
 * already show. A malformed one must never become a malformed `WHERE`.
 */
export function decodeOutboxHistoryCursor(
  value: string,
): FeedbackOutboxHistoryCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const separatorAt = decoded.indexOf(SEPARATOR);
  if (separatorAt === -1) {
    return null;
  }

  const createdAt = new Date(decoded.slice(0, separatorAt));
  const id = decoded.slice(separatorAt + SEPARATOR.length);

  if (Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    return null;
  }

  return { createdAt, id };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
