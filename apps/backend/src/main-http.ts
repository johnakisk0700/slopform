import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";

import { createHttpApplication } from "./bootstrap-http.js";
import type { Environment } from "./infrastructure/config/environment.js";

async function bootstrap(): Promise<void> {
  const app = await createHttpApplication();
  const config = app.get(ConfigService<Environment, true>);
  const logger = new Logger("HttpBootstrap");
  const port = config.get("API_PORT", { infer: true });
  const host = config.get("API_HOST", { infer: true });

  await app.listen(port, host);
  logger.log({ event: "http.started", host, port });
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(`HTTP bootstrap failed: ${String(error)}\n`);
  process.exitCode = 1;
});
