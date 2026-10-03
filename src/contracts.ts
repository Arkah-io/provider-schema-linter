import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const RULESET_VERSION = '2026-10-01' as const;
export const PROFILE_IDS = [
  'openai-strict',
  'anthropic-json-output',
  'gemini-json-output',
] as const;

export const profileIdSchema = z.enum(PROFILE_IDS);
export const lintOptionsSchema = z
  .object({ profile: profileIdSchema })
  .strict();
export const diagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string(),
  source: z.url(),
});
export const lintResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  rulesetVersion: z.literal(RULESET_VERSION),
  profile: profileIdSchema,
  diagnostics: z.array(diagnosticSchema),
});

export type ProfileId = z.infer<typeof profileIdSchema>;
export type LintOptions = z.infer<typeof lintOptionsSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type LintResult = z.infer<typeof lintResultSchema>;
