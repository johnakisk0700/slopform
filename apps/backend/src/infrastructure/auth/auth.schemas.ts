import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const authSessionSchema = z.object({
  status: z.literal("authorized"),
});

export const principalSchema = z.string().min(1).max(200);
export const correlationIdSchema = z.string().min(1).max(128);

export class AuthSessionDto extends createZodDto(authSessionSchema) {}

const PrincipalDtoBase = createZodDto(
  principalSchema,
) as unknown as new () => object;
const CorrelationIdDtoBase = createZodDto(
  correlationIdSchema,
) as unknown as new () => object;
export class PrincipalDto extends PrincipalDtoBase {}
export class CorrelationIdDto extends CorrelationIdDtoBase {}
