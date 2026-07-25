import * as z from "zod";

export const authSessionSchema = z.object({
  status: z.literal("authorized"),
});
