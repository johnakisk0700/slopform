import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import {
  configureHttpServer,
  createHelmetOptions,
  HTTP_BODY_LIMIT_BYTES,
  HTTP_HEADERS_TIMEOUT_MILLISECONDS,
  HTTP_MAX_HEADERS_COUNT,
  HTTP_REQUEST_TIMEOUT_MILLISECONDS,
} from "./http-policy.js";

describe("HTTP policy", () => {
  it("keeps production headers strict and local Swagger usable", () => {
    expect(createHelmetOptions("production")).toEqual({});
    expect(createHelmetOptions("development")).toEqual({
      contentSecurityPolicy: false,
      strictTransportSecurity: false,
    });
  });

  it("sets bounded request parsing limits", () => {
    const server = createServer();

    configureHttpServer(server);

    expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MILLISECONDS);
    expect(server.maxHeadersCount).toBe(HTTP_MAX_HEADERS_COUNT);
    expect(server.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MILLISECONDS);
    expect(HTTP_BODY_LIMIT_BYTES).toBe(102_400);
  });
});
