import {
  BadRequestException,
  Controller,
  Get,
  Logger as NestLogger,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger, LoggerModule } from "nestjs-pino";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLoggingParameters } from "./logging.module.js";

const records: Record<string, unknown>[] = [];
const parameters = createLoggingParameters({
  NODE_ENV: "test",
  LOG_LEVEL: "info",
});

@Controller()
class LoggingTestController {
  private readonly logger = new NestLogger(LoggingTestController.name);

  @Get("quiet")
  quiet() {
    return { ok: true };
  }

  @Get("event")
  event() {
    this.logger.log({
      event: "test.completed",
      jobId: "job-1",
      token: "private-token",
    });
    return { ok: true };
  }

  @Get("invalid")
  invalid() {
    throw new BadRequestException("Invalid input");
  }

  @Get("failure")
  failure() {
    throw new Error("Unexpected operation failure");
  }
}

@Module({
  imports: [
    LoggerModule.forRoot({
      ...parameters,
      pinoHttp: [
        parameters.pinoHttp as import("pino-http").Options,
        {
          write(chunk: string) {
            records.push(JSON.parse(chunk) as Record<string, unknown>);
          },
        },
      ],
    }),
  ],
  controllers: [LoggingTestController],
})
class LoggingTestModule {}

describe("HTTP application logging without automatic access records", () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(LoggingTestModule, {
      bufferLogs: true,
    });
    app.useLogger(app.get(Logger));
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    records.length = 0;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("does not duplicate successful requests or expected HTTP rejections", async () => {
    const success = await fetch(`${baseUrl}/quiet`);
    expect(success.status).toBe(200);
    await success.json();
    const invalid = await fetch(`${baseUrl}/invalid`);
    expect(invalid.status).toBe(400);
    await invalid.json();
    expect(records).toEqual([]);
  });

  it("keeps explicit events correlated and removes credentials from request context", async () => {
    const response = await fetch(`${baseUrl}/event?token=query-secret`, {
      headers: {
        "x-request-id": "request-123",
        authorization: "Bearer header-secret",
      },
    });
    await response.json();
    expect(response.headers.get("x-request-id")).toBe("request-123");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "test.completed",
      jobId: "job-1",
      token: "[Redacted]",
      context: "LoggingTestController",
      req: { id: "request-123", method: "GET", url: "/event" },
    });
    expect(JSON.stringify(records)).not.toMatch(
      /query-secret|header-secret|private-token/u,
    );
  });

  it("logs unexpected errors once with a stack and returns a safe 500", async () => {
    const response = await fetch(`${baseUrl}/failure`, {
      headers: { "x-request-id": "failure-123" },
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 50,
      req: { id: "failure-123" },
      err: {
        message: "Unexpected operation failure",
        stack: expect.stringContaining("LoggingTestController.failure"),
      },
    });
  });
});
