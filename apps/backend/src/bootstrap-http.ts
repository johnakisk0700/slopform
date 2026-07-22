import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { INestApplication } from "@nestjs/common";
import { Logger, LoggerErrorInterceptor } from "nestjs-pino";
import { cleanupOpenApiDoc } from "nestjs-zod";

import { HttpAppModule } from "./http-app.module.js";
import type { Environment } from "./infrastructure/config/environment.js";

export async function createHttpApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(HttpAppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Environment, true>);

  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.setGlobalPrefix("api/v1");
  app.enableCors({
    credentials: true,
    origin: config
      .get("WEB_ORIGIN", { infer: true })
      .split(",")
      .map((origin) => origin.trim()),
  });

  const openApiConfig = new DocumentBuilder()
    .setTitle("Join The Six API")
    .setDescription("Operations API for Join The Six")
    .setVersion("1.0.0")
    .build();
  const openApiDocument = cleanupOpenApiDoc(
    SwaggerModule.createDocument(app, openApiConfig, {
      operationIdFactory: (_controller, method) => method,
    }),
  );

  SwaggerModule.setup("api/docs", app, openApiDocument, {
    jsonDocumentUrl: "api/openapi.json",
    yamlDocumentUrl: "api/openapi.yaml",
  });

  return app;
}
