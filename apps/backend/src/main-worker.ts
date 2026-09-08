import "./infrastructure/config/load-environment.js";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";

import { WorkerAppModule } from "./worker-app.module.js";
import {
  closeFailedApplication,
  writeStructuredFatalEvent,
} from "./infrastructure/logging/startup-failure.js";

async function startWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    abortOnError: false,
    bufferLogs: true,
  });
  try {
    app.useLogger(app.get(PinoLogger));
    app.flushLogs();
    app.enableShutdownHooks();
    new Logger("WorkerBootstrap").log({ event: "worker.started" });
  } catch (error) {
    await closeFailedApplication(app, error);
  }
}

void startWorker().catch((error: unknown) => {
  writeStructuredFatalEvent("worker.bootstrap.failed", error);
  process.exitCode = 1;
});
