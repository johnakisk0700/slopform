import type { AddressInfo } from "node:net";

import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { HTTP_API_PREFIX } from "../../infrastructure/config/http-policy.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { QueueHealthService } from "../../infrastructure/queue/queue-health.service.js";
import { ConversationThreadRepository } from "../conversations/conversation-thread.repository.js";
import { HealthController } from "./health.controller.js";

const databasePing = vi.fn<() => Promise<void>>();
const mongodbPing = vi.fn<() => Promise<void>>();
const redisPing = vi.fn<() => Promise<void>>();

@Module({
  controllers: [HealthController],
  providers: [
    { provide: DatabaseService, useValue: { ping: databasePing } },
    {
      provide: ConversationThreadRepository,
      useValue: { ping: mongodbPing },
    },
    { provide: QueueHealthService, useValue: { ping: redisPing } },
  ],
})
class HealthHttpContractModule {}

function configureOpenApi(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Health contract")
    .setVersion("1.0.0")
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/openapi.json",
  });
}

describe("health readiness HTTP contract", () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      HealthHttpContractModule,
      { logger: false },
    );
    app.setGlobalPrefix(HTTP_API_PREFIX);
    configureOpenApi(app);

    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    databasePing.mockReset().mockResolvedValue(undefined);
    mongodbPing.mockReset().mockResolvedValue(undefined);
    redisPing.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("publishes PostgreSQL, MongoDB and Redis readiness in OpenAPI", async () => {
    const response = await fetch(`${baseUrl}/api/openapi.json`);
    const document = (await response.json()) as {
      paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
      components?: { schemas?: Record<string, unknown> };
    };
    const operation = document.paths["/api/v1/health/ready"]?.get;

    expect(response.status).toBe(200);
    expect(operation?.responses).toHaveProperty("200");
    expect(operation?.responses).toHaveProperty("503");
    expect(JSON.stringify(document.components?.schemas)).toContain('"mongodb"');
  });

  it("returns the complete dependency state when readiness succeeds", async () => {
    const response = await fetch(`${baseUrl}/api/v1/health/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checkedAt: expect.any(String),
      checks: { database: "up", mongodb: "up", redis: "up" },
    });
  });

  it("returns a safe 503 with MongoDB marked down", async () => {
    mongodbPing.mockRejectedValueOnce(
      new Error("mongodb://user:password@mongo/join_the_six"),
    );

    const response = await fetch(`${baseUrl}/api/v1/health/ready`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      checks: { database: "up", mongodb: "down", redis: "up" },
    });
  });
});
