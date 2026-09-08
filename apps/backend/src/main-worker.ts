import "./infrastructure/config/load-environment.js";

import { Logger, type INestApplicationContext } from "@nestjs/common";

import { createWorkerApplication } from "./bootstrap-worker.js";
import {
  handleStartupFailure,
  writeStructuredFatalEvent,
} from "./infrastructure/logging/startup-failure.js";

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
    ...(currentApplication
      ? { closeApplication: () => currentApplication.close() }
      : {}),
    event: "worker.bootstrap.failed",
    writeFatalEvent: writeStructuredFatalEvent,
  });

  process.exitCode = 1;
});
