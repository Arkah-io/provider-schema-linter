import {
  RULESET_VERSION,
  SCHEMA_VERSION,
  lintOptionsSchema,
  type Diagnostic,
  type LintOptions,
  type LintResult,
} from './contracts.js';
import { lintProfile } from './profiles.js';
import { readJsonInput, walkSchema } from './schema-walker.js';

/** Deterministic report order: path, then severity, code and message. */
export function compareDiagnostics(
  left: Diagnostic,
  right: Diagnostic,
): number {
  const leftKey = `${left.path}\0${left.severity}\0${left.code}\0${left.message}`;
  const rightKey = `${right.path}\0${right.severity}\0${right.code}\0${right.message}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * Lint the exact exported schema that will reach a provider. This never modifies the input.
 * A clean report means no known findings, not guaranteed API acceptance.
 * @example
 * lintSchema({ type: 'object', properties: { name: { type: 'string' } },
 *   required: ['name'], additionalProperties: false }, { profile: 'openai-strict' });
 */
export function lintSchema(schema: unknown, options: LintOptions): LintResult {
  const { profile } = lintOptionsSchema.parse(options);
  const input = readJsonInput(schema);
  const diagnostics = [...input.diagnostics];
  if (input.value !== undefined) {
    const graph = walkSchema(input.value, diagnostics);
    if (graph) diagnostics.push(...lintProfile(graph, profile));
  }
  diagnostics.sort(compareDiagnostics);
  return {
    schemaVersion: SCHEMA_VERSION,
    rulesetVersion: RULESET_VERSION,
    profile,
    diagnostics,
  };
}
