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
    redis: z.literal("up"),
  }),
});

export class LiveResponseDto extends createZodDto(liveResponseSchema) {}
export class ReadyResponseDto extends createZodDto(readyResponseSchema) {}
