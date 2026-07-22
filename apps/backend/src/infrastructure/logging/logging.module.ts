import { Module, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { trace } from "@opentelemetry/api";
import { LoggerModule, type Params } from "nestjs-pino";
import { randomUUID } from "node:crypto";

import type { Environment } from "../config/environment.js";
import {
  isLivenessRequest,
  requestPath,
} from "../observability/http-observability.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function validIncomingRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export function createLoggingParameters(
  environment: Pick<Environment, "LOG_LEVEL" | "NODE_ENV">,
  pretty = process.stdout.isTTY === true,
): Params {
  return {
    forRoutes: [{ path: "{*splat}", method: RequestMethod.ALL }],
    pinoHttp: {
      level: environment.LOG_LEVEL,
      ...(environment.NODE_ENV === "development" && pretty
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                colorize: true,
                ignore: "pid,hostname",
                singleLine: true,
                translateTime: "SYS:standard",
              },
            },
          }
        : {}),
      autoLogging: {
        ignore: (request) => isLivenessRequest(request.url),
      },
      customLogLevel(_request, response, error) {
        if (error || response.statusCode >= 500) {
          return "error";
        }

        return response.statusCode >= 400 ? "warn" : "info";
      },
      genReqId(request, response) {
        const requestId =
          validIncomingRequestId(request.headers["x-request-id"]) ??
          randomUUID();
        response.setHeader("x-request-id", requestId);
        return requestId;
      },
      // Per-record evaluation avoids stale/duplicate request span fields.
      mixin() {
        const spanContext = trace.getActiveSpan()?.spanContext();
        return spanContext
          ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
          : {};
      },
      redact: {
        censor: "[Redacted]",
        paths: [
          "authorization",
          "cookie",
          "password",
          "secret",
          "token",
          "*.authorization",
          "*.cookie",
          "*.password",
          "*.secret",
          "*.token",
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["proxy-authorization"]',
          'req.headers["x-api-key"]',
          "req.body.password",
          "req.body.secret",
          "req.body.token",
          'res.headers["set-cookie"]',
        ],
      },
      serializers: {
        req(request) {
          return {
            id: request.id,
            method: request.method,
            url: requestPath(request.url),
          };
        },
        res(response) {
          return { statusCode: response.statusCode };
        },
      },
    },
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        createLoggingParameters({
          LOG_LEVEL: config.get("LOG_LEVEL", { infer: true }),
          NODE_ENV: config.get("NODE_ENV", { infer: true }),
        }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
