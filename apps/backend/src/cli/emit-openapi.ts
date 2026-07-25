import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENAPI_EMIT_ENVIRONMENT } from "../infrastructure/openapi/openapi-document.js";

/**
 * Writes the published OpenAPI document to `apps/backend/openapi/openapi.json`.
 *
 * The document is built with `SwaggerModule.createDocument()` from the real
 * `createHttpApplication()` composition, so the committed artifact and the
 * document the running process serves at `/api/openapi.json` cannot drift. No
 * port is opened and no dependency is contacted: `NestFactory.create()` only
 * instantiates providers, and `onModuleInit` — which opens the database pool —
 * never runs because the application is never initialized.
 *
 * Run it from the repository root with `pnpm openapi:emit` (Turbo builds the
 * backend first) or with `pnpm --filter @join-the-six/backend openapi:emit`
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
  const [{ createHttpApplication }, openapi] = await Promise.all([
    import("../bootstrap-http.js"),
    import("../infrastructure/openapi/openapi-document.js"),
  ]);

  const app = await createHttpApplication();

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
  // Producer queue clients keep their Redis sockets scheduled; leave explicitly.
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `Failed to emit the OpenAPI document: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
