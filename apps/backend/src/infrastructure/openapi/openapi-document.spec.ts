import type { INestApplication } from "@nestjs/common";
import type { OpenAPIObject } from "@nestjs/swagger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OPENAPI_EMIT_ENVIRONMENT } from "./openapi-document.js";

describe("published OpenAPI document", () => {
  let application: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    for (const [name, value] of Object.entries(OPENAPI_EMIT_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }

    const [{ createHttpApplication }, openapi] = await Promise.all([
      import("../../bootstrap-http.js"),
      import("./openapi-document.js"),
    ]);
    application = await createHttpApplication();
    document = openapi.createOpenApiDocument(application);
  }, 30_000);

  afterAll(async () => {
    await application?.close();
    vi.unstubAllEnvs();
  });

  it("names every operation explicitly and uniquely", () => {
    const operationIds = operations(document).map(
      ([, operation]) => operation.operationId,
    );

    for (const operationId of operationIds) {
      // `AuthController_session` is the Nest default: it leaks a class name into
      // the generated hook name and renames on refactors. Declare the name with
      // `@ApiOperation({ operationId })` instead.
      expect(operationId).toMatch(/^[a-z][A-Za-z0-9]*$/u);
    }

    expect(new Set(operationIds).size).toBe(operationIds.length);
  });
});

/** `OperationObject` is not re-exported by the package root; derive it. */
type PublishedOperation = NonNullable<OpenAPIObject["paths"][string]["get"]>;

function operations(document: OpenAPIObject): [string, PublishedOperation][] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.values(item as Record<string, PublishedOperation>).map(
      (operation): [string, PublishedOperation] => [path, operation],
    ),
  );
}
