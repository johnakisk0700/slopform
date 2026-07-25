import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const authSessionSchema = z.object({
  status: z.literal("authorized"),
});

export class AuthSessionDto extends createZodDto(authSessionSchema) {}
