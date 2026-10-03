import { z } from 'zod';
import {
  profileIdSchema,
  type Diagnostic,
  type LintResult,
} from './contracts.js';
import { compareDiagnostics, lintSchema } from './lint.js';
import {
  diagnostic,
  isObject,
  readJsonInput,
  walkSchema,
  type JsonObject,
  type SchemaGraph,
} from './schema-walker.js';
import { lintZodSchema } from './zod.js';

export const LOOSE_EMIT_SOURCE =
  'https://github.com/Arkah-io/provider-schema-linter/blob/main/docs/loose-emit.md';

function typeIncludes(node: JsonObject, type: string): boolean {
  const declared = node.type;
  if (declared === undefined) return true;
  return (
    declared === type || (Array.isArray(declared) && declared.includes(type))
  );
}

/** Free text: a string the model composes, not a closed vocabulary or a formatted value. */
function isProse(node: JsonObject): boolean {
  return (
    typeIncludes(node, 'string') &&
    !('enum' in node) &&
    !('const' in node) &&
    !('pattern' in node) &&
    !('format' in node)
  );
}

type Classification = { prose: boolean; array: boolean };

/** Memoize reference chains so long aliases cannot multiply the bounded walk's work. */
function classifyBounds(
  graph: SchemaGraph,
): (path: string) => Classification | undefined {
  const cache = new Map<string, Classification | undefined>();
  return (path) => {
    const pending: { path: string; classification: Classification }[] = [];
    const seen = new Set<string>();
    let current = path;
    let result: Classification | undefined;
    while (!seen.has(current)) {
      if (cache.has(current)) {
        result = cache.get(current);
        break;
      }
      seen.add(current);
      const node = graph.byPath.get(current)?.value;
      if (node === true) {
        result = { prose: true, array: true };
        break;
      }
      if (!isObject(node)) break;
      // These policy checks do not solve intersections or unions.
      if (['allOf', 'anyOf', 'oneOf', 'not'].some((key) => key in node)) break;
      const classification = {
        prose: isProse(node),
        array: typeIncludes(node, 'array'),
      };
      pending.push({ path: current, classification });
      if (!('$ref' in node)) {
        result = classification;
        break;
      }
      const target = graph.references.get(current);
      if (target === undefined) break;
      current = target;
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      const entry = pending[index]!;
      result =
        result === undefined
          ? undefined
          : {
              prose: entry.classification.prose && result.prose,
              array: entry.classification.array && result.array,
            };
      cache.set(entry.path, result);
    }
    if (!cache.has(path)) cache.set(path, result);
    return cache.get(path);
  };
}

function isBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Application policy, not a provider rule: report bounds in a schema the model emits that
 * normalization may own instead. Provider enforcement and SDK conversion vary; these
 * findings do not predict API behavior or prove that truncation is appropriate.
 * Findings are warnings; the schema is never modified.
 * @example lintLooseEmit({ type: 'string', maxLength: 80 }); // [emit.prose-length-bound]
 */
export function lintLooseEmit(schema: unknown): Diagnostic[] {
  const input = readJsonInput(schema);
  const diagnostics = [...input.diagnostics];
  if (input.value === undefined) return diagnostics;
  const graph = walkSchema(input.value, diagnostics);
  if (!graph) return diagnostics;
  const classify = classifyBounds(graph);
  for (const { value: node, path } of graph.nodes) {
    if (!isObject(node)) continue;
    if (!isBound(node.maxLength) && !isBound(node.maxItems)) continue;
    const classification = classify(path);
    if (isBound(node.maxLength) && classification?.prose) {
      diagnostics.push(
        diagnostic(
          'emit.prose-length-bound',
          path,
          `maxLength ${node.maxLength} on a free-text candidate. If deterministic shortening is appropriate, move this bound to the strict schema and implement shortening in normalize.`,
          'warning',
          LOOSE_EMIT_SOURCE,
        ),
      );
    }
    if (isBound(node.maxItems) && classification?.array) {
      diagnostics.push(
        diagnostic(
          'emit.array-max-items',
          path,
          `maxItems ${node.maxItems} on emitted output. If dropping excess items is appropriate, move this cap to the strict schema and implement the selection policy in normalize.`,
          'warning',
          LOOSE_EMIT_SOURCE,
        ),
      );
    }
  }
  return diagnostics.sort(compareDiagnostics);
}

export type EmitContract<Emit extends z.ZodType, Strict extends z.ZodType> = {
  /** Exportable shape used to parse raw output. Prefer synchronous schemas without transforms. */
  readonly emit: Emit;
  /** The durable contract you store and render. */
  readonly strict: Strict;
  /** Synchronous, deterministic repair from emitted shape to strict input. */
  readonly normalize: (emitted: z.output<Emit>) => z.input<Strict>;
  /** Validate raw model output against `emit`, normalize it, then parse it with `strict`. */
  parse(raw: unknown): z.output<Strict>;
};

/**
 * Pair the schema a model emits with the schema you persist, joined by a pure normalizer.
 * `parse` preserves Zod validation errors and exceptions thrown by normalize. The caller
 * owns the normalization policy; the helper cannot establish that arbitrary code is pure.
 * Use synchronous schemas and normalizers. Returned Promises/thenables are rejected.
 * @example
 * const Title = defineEmitContract({
 *   emit: z.strictObject({ title: z.string() }),
 *   strict: z.strictObject({ title: z.string().min(1).max(80) }),
 *   normalize: ({ title }) => ({ title: title.trim().slice(0, 80) }),
 * });
 * Title.parse(modelJson); // { title: '…at most 80 characters' }
 */
export function defineEmitContract<
  Emit extends z.ZodType,
  Strict extends z.ZodType,
>(contract: {
  emit: Emit;
  strict: Strict;
  normalize: (emitted: z.output<Emit>) => z.input<Strict>;
}): EmitContract<Emit, Strict> {
  const { emit, strict, normalize } = contract;
  return Object.freeze({
    emit,
    strict,
    normalize,
    parse: (raw: unknown) => {
      const emitted = requireSynchronous(emit.parse(raw), 'emit.parse');
      const normalized = requireSynchronous(normalize(emitted), 'normalize');
      return requireSynchronous(strict.parse(normalized), 'strict.parse');
    },
  });
}

function requireSynchronous<T>(value: T, stage: string): T {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    try {
      // Handle native Promise rejections without invoking a custom thenable's code.
      void Promise.prototype.then.call(value, undefined, () => undefined);
    } catch {
      // Non-Promise thenables have no native rejection to handle.
    }
    throw new TypeError(
      `${stage} must be synchronous; received a Promise or thenable.`,
    );
  }
  return value;
}

const emitContractCheckOptionsSchema = z
  .object({
    /** Every provider profile this call can be routed to, including fallbacks. */
    profiles: z
      .array(profileIdSchema)
      .min(1, 'List at least one provider profile.')
      .readonly(),
    /**
     * Representative raw outputs, especially verbose ones. Each must survive `parse`;
     * this checks those examples, not every possible model output.
     */
    samples: z.array(z.unknown()).readonly().optional(),
    /** Zod export mode, matching your SDK's converter. Default `output`. */
    io: z.enum(['input', 'output']).optional(),
    warningsAsErrors: z.boolean().optional(),
  })
  .strict();

export type EmitContractCheckOptions = z.infer<
  typeof emitContractCheckOptionsSchema
>;

export type EmitContractReport = {
  ok: boolean;
  /** Provider findings for the exported emit schema, one result per profile. */
  providers: LintResult[];
  /** Loose-emit policy findings for the exported emit schema. */
  looseEmit: Diagnostic[];
  /** Samples that validation or normalization rejected, by index. Messages are capped at 2,000 characters. */
  sampleFailures: { index: number; message: string }[];
};

/**
 * Export once, lint that schema for each requested profile, and parse supplied samples.
 * `ok` means no configured check failed; it does not guarantee API acceptance or general
 * normalizer correctness. Warnings are ignored unless `warningsAsErrors` is enabled.
 */
export function checkEmitContract<
  Emit extends z.ZodType,
  Strict extends z.ZodType,
>(
  contract: EmitContract<Emit, Strict>,
  options: EmitContractCheckOptions,
): EmitContractReport {
  const parsed = emitContractCheckOptionsSchema.parse(options);
  const first = lintZodSchema(contract.emit, {
    profile: parsed.profiles[0]!,
    io: parsed.io ?? 'output',
  });
  const exported = first.jsonSchema;
  const providers = parsed.profiles.map((profile, index) => {
    if (index === 0) return first.result;
    return exported === undefined
      ? {
          ...first.result,
          profile,
          diagnostics: first.result.diagnostics.map((finding) => ({
            ...finding,
          })),
        }
      : lintSchema(exported, { profile });
  });
  const looseEmit = exported === undefined ? [] : lintLooseEmit(exported);
  const sampleFailures: EmitContractReport['sampleFailures'] = [];
  parsed.samples?.forEach((sample, index) => {
    try {
      requireSynchronous(contract.parse(sample), 'contract.parse');
    } catch (error) {
      sampleFailures.push({
        index,
        message: sampleFailureMessage(error),
      });
    }
  });
  const fails = (d: Diagnostic) =>
    d.severity === 'error' || parsed.warningsAsErrors === true;
  const ok =
    sampleFailures.length === 0 &&
    !looseEmit.some(fails) &&
    !providers.some((result) => result.diagnostics.some(fails));
  return { ok, providers, looseEmit, sampleFailures };
}

function sampleFailureMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return typeof message === 'string'
      ? message.slice(0, 2000)
      : 'Parsing or normalization threw an error without a string message.';
  } catch {
    return 'Parsing or normalization threw a value that could not be described.';
  }
}

/**
 * Test-runner-agnostic assertion for node:test, vitest or jest.
 * @example
 * test('title contract', () => assertEmitContract(Title, {
 *   profiles: ['openai-strict', 'anthropic-json-output'],
 *   samples: [{ title: 'x'.repeat(500) }],
 * }));
 */
export function assertEmitContract<
  Emit extends z.ZodType,
  Strict extends z.ZodType,
>(
  contract: EmitContract<Emit, Strict>,
  options: EmitContractCheckOptions,
): void {
  const report = checkEmitContract(contract, options);
  if (report.ok) return;
  const lines: string[] = [];
  const show = (label: string, d: Diagnostic) =>
    lines.push(
      `${label} ${d.severity} ${d.code} ${d.path || '<root>'}: ${d.message}`,
    );
  for (const result of report.providers)
    for (const d of result.diagnostics) show(result.profile, d);
  for (const d of report.looseEmit) show('loose-emit', d);
  for (const failure of report.sampleFailures)
    lines.push(`sample ${failure.index} failed parse: ${failure.message}`);
  throw new Error(`Emit contract check failed:\n${lines.join('\n')}`);
}
