import type { INestApplication } from "@nestjs/common";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";

/**
 * The single definition of the published OpenAPI document.
 *
 * The running HTTP process serves it (`bootstrap-http.ts`) and the emit CLI
 * writes the same document to `apps/backend/openapi/openapi.json`, which is the
 * only input of the admin client codegen. Both paths must produce byte-identical
 * output, so nothing here may depend on the clock, the environment or hash
 * ordering: every object key is sorted before serialization.
 */
const OPENAPI_TITLE = "Join The Six API";
const OPENAPI_DESCRIPTION = "Operations API for Join The Six";
const OPENAPI_VERSION = "1.0.0";
export const OPENAPI_JSON_ROUTE = "api/openapi.json";
export const OPENAPI_YAML_ROUTE = "api/openapi.yaml";
export const OPENAPI_DOCS_ROUTE = "api/docs";

/**
 * The environment the published contract describes.
 *
 * `@nestjs/config` lets `process.env` win over the `.env` file and the
 * conditionally registered modules read `process.env` directly, so applying
 * these values before the application module is imported makes the emitted
 * artifact a function of source code alone. The published composition is the
 * default one: the Wasender webhook, the reference module and Bull Board are
 * off. Promoting one of them to a product surface means publishing it here
 * deliberately. Credentials are absent because no dependency is contacted.
 */
export const OPENAPI_EMIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  API_HOST: "127.0.0.1",
  API_PORT: "4000",
  AUTH_DEV_BYPASS: "true",
  BULL_BOARD_ENABLED: "false",
  BULL_BOARD_PASSWORD: "",
  BULL_BOARD_USERNAME: "",
  CLERK_ADMIN_USER_IDS: "",
  CLERK_PUBLISHABLE_KEY: "",
  CLERK_SECRET_KEY: "",
  DATABASE_POOL_MAX: "1",
  DATABASE_URL: "postgresql://openapi:openapi@127.0.0.1:5432/openapi",
  LOG_LEVEL: "silent",
  MONGODB_URI: "mongodb://127.0.0.1:27017/openapi",
  NODE_ENV: "development",
  OPENAI_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_SERVICE_NAME: "join-the-six-api",
  REDIS_URL: "redis://127.0.0.1:6379",
  REFERENCE_MODULE_ENABLED: "false",
  SENTRY_DSN: "",
  SENTRY_TRACES_SAMPLE_RATE: "0",
  WASENDER_SESSION_API_KEY: "",
  WASENDER_WEBHOOK_ENABLED: "false",
  WASENDER_WEBHOOK_SECRET: "",
  FEEDBACK_SIMULATOR_ENABLED: "false",
  WEB_ORIGIN: "http://localhost:3000",
};

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(OPENAPI_TITLE)
    .setDescription(OPENAPI_DESCRIPTION)
    .setVersion(OPENAPI_VERSION)
    .build();

  return sortDocumentKeys(
    cleanupOpenApiDoc(SwaggerModule.createDocument(app, config)),
  );
}

/** Serializes the document exactly as the committed artifact stores it. */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(document, undefined, 2)}\n`;
}

/**
 * Recursively sorts object keys with a locale-independent comparison so an
 * added route produces a local diff instead of a reshuffled file. Arrays keep
 * their order because OpenAPI gives it meaning (`required`, `enum`, `tags`).
 */
function sortDocumentKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => sortDocumentKeys(entry)) as T;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const sorted = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );

  return Object.fromEntries(
    sorted.map(([key, entry]) => [key, sortDocumentKeys(entry)]),
  ) as T;
}
