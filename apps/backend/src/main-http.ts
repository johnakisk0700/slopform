import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { createHttpApplication } from "./bootstrap-http.js";
import type { Environment } from "./infrastructure/config/environment.js";
import {
  handleStartupFailure,
  writeStructuredFatalEvent,
} from "./infrastructure/observability/startup-failure.js";
import {
  captureStartupException,
  shutdownTelemetry,
} from "./instrumentation.js";

let application: NestExpressApplication | undefined;

async function bootstrap(): Promise<void> {
  const app = await createHttpApplication((createdApplication) => {
    application = createdApplication;
  });
  const config = app.get(ConfigService<Environment, true>);
  const logger = new Logger("HttpBootstrap");
  const port = config.get("API_PORT", { infer: true });
  const host = config.get("API_HOST", { infer: true });

  await app.listen(port, host);

  logger.log({ event: "http.started", host, port });
}

void bootstrap().catch(async (error: unknown) => {
  const currentApplication = application;

  await handleStartupFailure(error, {
    capture: captureStartupException,
    ...(currentApplication
      ? { closeApplication: () => currentApplication.close() }
      : {}),
    event: "http.bootstrap.failed",
    shutdownTelemetry,
    writeFatalEvent: writeStructuredFatalEvent,
  });

  process.exitCode = 1;
});
