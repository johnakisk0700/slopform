import type { HelmetOptions } from "helmet";
import type { Server } from "node:http";

import type { Environment } from "./environment.js";

export const HTTP_BODY_LIMIT_BYTES = 100 * 1_024;
export const HTTP_HEADERS_TIMEOUT_MILLISECONDS = 10_000;
export const HTTP_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
export const HTTP_MAX_HEADERS_COUNT = 100;
export const HTTP_API_PREFIX = "api/v1";

export function createHelmetOptions(
  nodeEnvironment: Environment["NODE_ENV"],
): HelmetOptions {
  return nodeEnvironment === "production"
    ? {}
    : { contentSecurityPolicy: false, strictTransportSecurity: false };
}

export function configureHttpServer(server: Server): void {
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MILLISECONDS;
  server.maxHeadersCount = HTTP_MAX_HEADERS_COUNT;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MILLISECONDS;
}
