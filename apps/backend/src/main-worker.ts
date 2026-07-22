import { Logger, type INestApplicationContext } from "@nestjs/common";

import { createWorkerApplication } from "./bootstrap-worker.js";
import {
  handleStartupFailure,
  writeStructuredFatalEvent,
} from "./infrastructure/observability/startup-failure.js";
import {
  captureStartupException,
  shutdownTelemetry,
} from "./instrumentation.js";

let application: INestApplicationContext | undefined;

async function bootstrap(): Promise<void> {
  await createWorkerApplication((createdApplication) => {
    application = createdApplication;
  });

  new Logger("WorkerBootstrap").log({ event: "worker.started" });
}

void bootstrap().catch(async (error: unknown) => {
  const currentApplication = application;

  await handleStartupFailure(error, {
    capture: captureStartupException,
    ...(currentApplication
      ? { closeApplication: () => currentApplication.close() }
      : {}),
    event: "worker.bootstrap.failed",
    shutdownTelemetry,
    writeFatalEvent: writeStructuredFatalEvent,
  });

  process.exitCode = 1;
});
