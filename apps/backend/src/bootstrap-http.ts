import { clerkMiddleware } from "@clerk/express";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { Logger, LoggerErrorInterceptor } from "nestjs-pino";

import { HttpAppModule } from "./http-app.module.js";
import { AuthConfigService } from "./infrastructure/auth/auth-config.service.js";
import type { Environment } from "./infrastructure/config/environment.js";
import {
  configureHttpServer,
  createHelmetOptions,
  HTTP_API_PREFIX,
  HTTP_BODY_LIMIT_BYTES,
} from "./infrastructure/config/http-policy.js";
import {
  createOpenApiDocument,
  OPENAPI_DOCS_ROUTE,
  OPENAPI_JSON_ROUTE,
  OPENAPI_YAML_ROUTE,
} from "./infrastructure/openapi/openapi-document.js";

export async function createHttpApplication(
  onCreated?: (application: NestExpressApplication) => void,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(HttpAppModule, {
    abortOnError: false,
    bodyParser: false,
    bufferLogs: true,
  });
  onCreated?.(app);

  const config = app.get(ConfigService<Environment, true>);
  const authConfig = app.get(AuthConfigService);
  const nodeEnvironment = config.get("NODE_ENV", { infer: true });

  if (!authConfig.devBypassEnabled) {
    const clerkClient = authConfig.clerkClient;

    if (!clerkClient) {
      throw new Error(
        "Clerk client is missing while authentication is enabled",
      );
    }

    // Clerk must inspect the untouched request before any other Express middleware.
    app.use(
      clerkMiddleware({
        authorizedParties: [...authConfig.authorizedParties],
        clerkClient,
      }),
    );
  }
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());
  app.enableShutdownHooks();
  app.use(helmet(createHelmetOptions(nodeEnvironment)));
  app.useBodyParser("json", { limit: HTTP_BODY_LIMIT_BYTES });
  app.useBodyParser("urlencoded", {
    extended: false,
    limit: HTTP_BODY_LIMIT_BYTES,
    parameterLimit: 100,
  });
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  // Authorization must not depend on forwarded metadata.
  app.set("trust proxy", false);
  app.setGlobalPrefix(HTTP_API_PREFIX);
  app.enableCors({
    credentials: true,
    maxAge: 600,
    origin: config.get("WEB_ORIGIN", { infer: true }),
  });

  if (nodeEnvironment !== "production") {
    SwaggerModule.setup(OPENAPI_DOCS_ROUTE, app, createOpenApiDocument(app), {
      jsonDocumentUrl: OPENAPI_JSON_ROUTE,
      yamlDocumentUrl: OPENAPI_YAML_ROUTE,
    });
  }

  configureHttpServer(app.getHttpServer());

  return app;
}
