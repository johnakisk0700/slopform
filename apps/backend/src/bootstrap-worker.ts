import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";

import { WorkerAppModule } from "./worker-app.module.js";

export async function createWorkerApplication(
  onCreated?: (application: INestApplicationContext) => void,
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    abortOnError: false,
    bufferLogs: true,
  });
  onCreated?.(app);

  app.useLogger(app.get(Logger));
  app.flushLogs();
  app.enableShutdownHooks();

  return app;
}
