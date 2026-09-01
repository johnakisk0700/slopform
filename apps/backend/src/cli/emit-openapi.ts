import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENAPI_EMIT_ENVIRONMENT } from "../infrastructure/openapi/openapi-document.js";

/**
 * Writes the published OpenAPI document to `apps/backend/openapi/openapi.json`.
 *
 * The document is built with `SwaggerModule.createDocument()` from the real
 * `HttpAppModule` graph, so the committed artifact and the document the running
 * process serves at `/api/openapi.json` cannot drift. Nest preview mode scans
 * that graph without instantiating controllers or providers, so no port is
 * opened and no dependency is contacted.
 *
 * Run it from the repository root with `pnpm openapi:emit` (Turbo builds the
 * backend first) or with `pnpm --filter @slopform/backend openapi:emit`
 * against a current `dist/`.
 */
const OUTPUT_URL = new URL("../../openapi/openapi.json", import.meta.url);

async function emitOpenApiDocument(): Promise<string> {
  for (const [name, value] of Object.entries(OPENAPI_EMIT_ENVIRONMENT)) {
    process.env[name] = value;
  }

  // Module composition messages are not output of this command. The override
  // must land before the application module is imported, because conditional
  // registration is evaluated while that module is being defined.
  const { Logger } = await import("@nestjs/common");
  Logger.overrideLogger(false);

  // Imported after the environment is fixed: the module graph reads it eagerly.
  const [{ NestFactory }, { HttpAppModule }, { HTTP_API_PREFIX }, openapi] =
    await Promise.all([
      import("@nestjs/core"),
      import("../http-app.module.js"),
      import("../infrastructure/config/http-policy.js"),
      import("../infrastructure/openapi/openapi-document.js"),
    ]);

  const app = await NestFactory.create(HttpAppModule, {
    abortOnError: false,
    bodyParser: false,
    logger: false,
    preview: true,
  });
  app.setGlobalPrefix(HTTP_API_PREFIX);

  try {
    const contents = openapi.serializeOpenApiDocument(
      openapi.createOpenApiDocument(app),
    );
    const outputPath = fileURLToPath(OUTPUT_URL);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents, "utf8");
    return outputPath;
  } finally {
    await app.close();
  }
}

try {
  const outputPath = await emitOpenApiDocument();
  process.stdout.write(`OpenAPI document written to ${outputPath}\n`);
} catch (error) {
  process.stderr.write(
    `Failed to emit the OpenAPI document: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
