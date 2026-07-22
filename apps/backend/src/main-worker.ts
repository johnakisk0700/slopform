import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";

import { WorkerAppModule } from "./worker-app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  app.flushLogs();
  app.enableShutdownHooks();

  new Logger("WorkerBootstrap").log({ event: "worker.started" });
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(`Worker bootstrap failed: ${String(error)}\n`);
  process.exitCode = 1;
});
