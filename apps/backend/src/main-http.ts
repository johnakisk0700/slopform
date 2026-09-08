import "./infrastructure/config/load-environment.js";

import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";

import { createHttpApplication } from "./bootstrap-http.js";
import type { Environment } from "./infrastructure/config/environment.js";
import {
  closeFailedApplication,
  writeStructuredFatalEvent,
} from "./infrastructure/logging/startup-failure.js";

async function startHttp(): Promise<void> {
  const app = await createHttpApplication();
  try {
    const config = app.get(ConfigService<Environment, true>);
    const port = config.get("API_PORT", { infer: true });
    const host = config.get("API_HOST", { infer: true });

    await app.listen(port, host);
    new Logger("HttpBootstrap").log({ event: "http.started", host, port });
  } catch (error) {
    await closeFailedApplication(app, error);
  }
}

void startHttp().catch((error: unknown) => {
  writeStructuredFatalEvent("http.bootstrap.failed", error);
  process.exitCode = 1;
});
