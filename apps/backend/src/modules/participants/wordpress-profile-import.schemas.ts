import {
  PARTICIPANT_AGE_BANDS,
  PARTICIPANT_INTERESTS,
  PARTICIPANT_NEIGHBORHOODS,
} from "@join-the-six/database";
import { z } from "zod";

export const WORDPRESS_PROFILE_IMPORT_SCHEMA_VERSION = 1;
export const WORDPRESS_PROFILE_SOURCE = "wordpress-jts-profile";

const wordpressAnswersSchema = z
  .object({
    name: z.unknown(),
    age: z.unknown(),
    telephone: z.unknown(),
    city: z.unknown(),
    interests: z.unknown(),
    personality: z.unknown(),
    email: z.unknown(),
  })
  .strict();

export const wordpressProfileExportSchema = z
  .object({
    schemaVersion: z.literal(WORDPRESS_PROFILE_IMPORT_SCHEMA_VERSION),
    source: z.literal(WORDPRESS_PROFILE_SOURCE),
    exportedAt: z.iso.datetime({ offset: true }),
    profiles: z.array(
      z
        .object({
          sourceProfileId: z.union([z.string(), z.number()]),
          sourceUserId: z.union([z.string(), z.number()]).nullable().optional(),
          sourceStatus: z.enum([
            "publish",
            "private",
            "draft",
            "pending",
            "future",
            "trash",
          ]),
          sourceUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
          answers: wordpressAnswersSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const canonicalParticipantProfileSchema = z
  .object({
    preferredName: z.string().trim().min(1).max(120).nullable(),
    emailNormalized: z.email().max(320),
    phoneE164: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullable(),
    ageBand: z.enum(PARTICIPANT_AGE_BANDS).nullable(),
    preferredNeighborhood: z.enum(PARTICIPANT_NEIGHBORHOODS).nullable(),
    conversationStyle: z.number().int().min(1).max(5).nullable(),
    interests: z
      .array(z.enum(PARTICIPANT_INTERESTS))
      .max(5)
      .refine((values) => new Set(values).size === values.length, {
        message: "Interests must be unique",
      }),
  })
  .strict();

export type WordpressProfileExport = z.infer<
  typeof wordpressProfileExportSchema
>;
export type WordpressProfileExportRow =
  WordpressProfileExport["profiles"][number];
export type CanonicalParticipantProfile = z.infer<
  typeof canonicalParticipantProfileSchema
>;

export interface CanonicalWordpressProfile {
  readonly sourceProfileId: string;
  readonly sourceUserId?: string;
  readonly sourceUpdatedAt?: Date;
  readonly payloadHash: string;
  readonly profile: CanonicalParticipantProfile;
}

export type WordpressProfileMappingResult =
  | { readonly ok: true; readonly value: CanonicalWordpressProfile }
  | {
      readonly ok: false;
      readonly sourceProfileId: string;
      readonly code: "invalid_profile";
      readonly issues: readonly string[];
    };
