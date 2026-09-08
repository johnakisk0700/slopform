import { Module, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule, type Params } from "nestjs-pino";
import { randomUUID } from "node:crypto";

import type { Environment } from "../config/environment.js";

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
      // The nginx access log owns request completion records.
      autoLogging: false,
      genReqId(request, response) {
        const requestId =
          validIncomingRequestId(request.headers["x-request-id"]) ??
          randomUUID();
        response.setHeader("x-request-id", requestId);
        return requestId;
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
            url: request.url?.split(/[?#]/u, 1)[0],
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
