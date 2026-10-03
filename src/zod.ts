import { z } from 'zod';
import {
  lintOptionsSchema,
  RULESET_VERSION,
  SCHEMA_VERSION,
} from './contracts.js';
import type { LintResult } from './contracts.js';
import { lintSchema } from './lint.js';

export const zodLintOptionsSchema = lintOptionsSchema.extend({
  io: z.enum(['input', 'output']).default('output'),
});
export type ZodLintOptions = z.input<typeof zodLintOptionsSchema>;

const exportSchema = (schema: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io });

function conversionFailureMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : error;
    return typeof message === 'string'
      ? message.slice(0, 1000)
      : 'unknown conversion failure';
  } catch {
    return 'conversion threw an error whose message could not be read';
  }
}

export type ZodLintResult = {
  jsonSchema?: ReturnType<typeof exportSchema>;
  result: LintResult;
};

/**
 * Export Zod 4 with its native converter, then lint the emitted schema.
 * Conversion failures stay visible; unrepresentable types are never erased.
 * @example
 * lintZodSchema(z.object({ note: z.string().nullable() }), { profile: 'openai-strict' });
 */
export function lintZodSchema(
  schema: z.ZodType,
  options: ZodLintOptions,
): ZodLintResult {
  const parsed = zodLintOptionsSchema.parse(options);
  let jsonSchema: ReturnType<typeof exportSchema>;
  try {
    jsonSchema = exportSchema(schema, parsed.io);
  } catch (error) {
    return {
      result: {
        schemaVersion: SCHEMA_VERSION,
        rulesetVersion: RULESET_VERSION,
        profile: parsed.profile,
        diagnostics: [
          {
            code: 'conversion.zod',
            severity: 'error',
            path: '',
            message: `Zod could not export this schema: ${conversionFailureMessage(error)}`,
            source: 'https://zod.dev/json-schema',
          },
        ],
      },
    };
  }
  return {
    jsonSchema,
    result: lintSchema(jsonSchema, { profile: parsed.profile }),
  };
}
