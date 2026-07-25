import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const liveResponseSchema = z.object({
  status: z.literal("ok"),
  checkedAt: z.iso.datetime(),
});

const readyResponseSchema = z.object({
  status: z.literal("ready"),
  checkedAt: z.iso.datetime(),
  checks: z.object({
    database: z.literal("up"),
    mongodb: z.literal("up"),
    redis: z.literal("up"),
  }),
});

const notReadyResponseSchema = z.object({
  status: z.literal("not_ready"),
  checks: z.object({
    database: z.enum(["up", "down"]),
    mongodb: z.enum(["up", "down"]),
    redis: z.enum(["up", "down"]),
  }),
});

export class LiveResponseDto extends createZodDto(liveResponseSchema) {}
export class ReadyResponseDto extends createZodDto(readyResponseSchema) {}
export class NotReadyResponseDto extends createZodDto(notReadyResponseSchema) {}
