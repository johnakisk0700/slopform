import { HTTP_API_PREFIX } from "../config/http-policy.js";

const LIVENESS_PATH = `/${HTTP_API_PREFIX}/health/live`;

export function requestPath(url: string | undefined): string | undefined {
  return url?.split(/[?#]/u, 1)[0];
}

export function isLivenessRequest(url: string | undefined): boolean {
  return requestPath(url) === LIVENESS_PATH;
}
