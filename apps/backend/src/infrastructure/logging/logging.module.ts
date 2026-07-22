import { Module, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { trace } from "@opentelemetry/api";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";

import type { Environment } from "../config/environment.js";

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        forRoutes: [{ path: "{*splat}", method: RequestMethod.ALL }],
        pinoHttp: {
          level: config.get("LOG_LEVEL", { infer: true }),
          genReqId(request, response) {
            const suppliedId = request.headers["x-request-id"];
            const requestId =
              typeof suppliedId === "string" && suppliedId.length <= 128
                ? suppliedId
                : randomUUID();
            response.setHeader("x-request-id", requestId);
            return requestId;
          },
          customProps() {
            const spanContext = trace.getActiveSpan()?.spanContext();
            return spanContext
              ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
              : {};
          },
          redact: {
            censor: "[Redacted]",
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.body.password",
              "req.body.token",
              'res.headers["set-cookie"]',
            ],
          },
          serializers: {
            req(request) {
              return {
                id: request.id,
                method: request.method,
                url: request.url,
              };
            },
            res(response) {
              return { statusCode: response.statusCode };
            },
          },
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
