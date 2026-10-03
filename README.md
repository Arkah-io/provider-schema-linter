# arkah-provider-schema-linter

## Lint the schema the provider actually sees

A schema can type-check in your application and still fail when it reaches a model API. An optional field may violate strict mode. A number bound may survive one provider's converter and disappear in another. A transform can fail before the request is sent.

These failures often surface in a model retry loop, even though retrying the same schema cannot fix them.

`arkah-provider-schema-linter` checks exported JSON Schema before that request. It provides a TypeScript API, a CLI for CI, a Zod 4 export helper, and an optional loose-emit check for bounds that should be normalized rather than sent to the model. Findings include a stable code, severity, JSON Pointer, and documentation link. Everything runs locally without credentials or model calls.

```text
$ provider-schema-lint --profile openai-strict report.schema.json
openai-strict · rules 2026-10-01
ERROR openai.additional-properties "/properties/labels/additionalProperties"
  "Every object must explicitly set additionalProperties to false in this output mode."
  https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
WARNING openai.undocumented-keyword "/properties/title/minLength"
  "minLength is outside this profile's documented subset. Support or enforcement is not guaranteed; verify it for your model and endpoint."
  https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
ERROR openai.required-properties "/required"
  "Every property must be required. Missing: \"labels\". Use a required nullable field for optional values."
  https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
2 error(s), 1 warning(s)
```

**Status:** v0.1.0 preview, independently maintained. ESM only. Independent of OpenAI, Anthropic and Google. The examples are synthetic schemas.

## Install

```sh
pnpm add arkah-provider-schema-linter zod@^4.6.5
pnpm exec provider-schema-lint --help
```

Source and issues: [Arkah-io/provider-schema-linter](https://github.com/Arkah-io/provider-schema-linter).

### Try the demo

Requires Node.js 20+ and pnpm 9. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm demo
node dist/cli.js --profile openai-strict examples/portable-report.schema.json
node dist/cli.js --profile anthropic-json-output --json examples/report-with-pitfalls.schema.json
```

The Anthropic command intentionally exits `1`: Anthropic's native structured-output subset rejects several constraints in that example. The demo compares all three profiles and checks an optional-to-nullable change with Zod. [Read the demo](examples/demo.mjs).

To test a local candidate in another project, run `pnpm pack` here, then `pnpm add /absolute/path/to/arkah-provider-schema-linter-0.1.0.tgz zod@^4.6.5` there. Zod is a peer dependency, so `lintZodSchema` exports your own Zod instances.

## The useful boundary is after export

Consider this JSON Schema:

```json
{
  "type": "object",
  "properties": {
    "note": { "type": "string" }
  },
  "additionalProperties": false
}
```

It allows the `note` property to be absent. OpenAI strict mode requires every declared property to appear in `required`. Anthropic's native JSON output permits optional properties. The same authoring intent therefore needs different handling depending on the target. [OpenAI subset](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas), [Anthropic subset](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations).

If your application accepts a present-but-empty value, you can require `note` and allow `null`:

```json
{
  "type": "object",
  "properties": {
    "note": { "type": ["string", "null"] }
  },
  "required": ["note"],
  "additionalProperties": false
}
```

That is a contract change. This package reports the issue; it does not silently rewrite optionality, remove bounds, close maps, or inline references.

```text
Authoring schema → your SDK/adapter export → lintSchema → provider request
                                                      ↘ validate returned data
```

Keep runtime validation. Passing this linter means no enabled rule found a problem. It does not prove provider acceptance, validate generated data, or guarantee enforcement of a constraint.

## Use the library

```ts
import { lintSchema } from 'arkah-provider-schema-linter';

const schema = {
  type: 'object',
  properties: { note: { type: ['string', 'null'] } },
  required: ['note'],
  additionalProperties: false,
};

const result = lintSchema(schema, { profile: 'openai-strict' });
for (const finding of result.diagnostics) {
  console.log(finding.code, finding.path, finding.message, finding.source);
}
if (result.diagnostics.some((finding) => finding.severity === 'error')) {
  throw new Error('Fix the schema before starting the agent.');
}
```

Use this at schema registration or in CI. For LangChain/LangGraph, pass the JSON Schema produced by the same converter and adapter used for your tools or structured output. An SDK can rewrite the original schema, so checking a different export can miss the defect you are trying to catch.

### Lint every structured-output call in one test

A single CLI run catches one schema. The habit that lasts is one test that lists every schema your application sends to a model, with each provider that call can be routed to. When someone adds a fallback provider or a new field, the test fails in review instead of in a retry loop.

```ts
import { test } from 'node:test'; // or vitest
import assert from 'node:assert/strict';
import { lintZodSchema } from 'arkah-provider-schema-linter/zod';
import { ReportSchema, TriageSchema } from './schemas.js';

const targets = [
  {
    name: 'report',
    schema: ReportSchema,
    profiles: ['openai-strict', 'anthropic-json-output'],
  },
  { name: 'triage', schema: TriageSchema, profiles: ['openai-strict'] },
] as const;

for (const { name, schema, profiles } of targets) {
  for (const profile of profiles) {
    test(`${name} has no known errors for ${profile}`, () => {
      const { result } = lintZodSchema(schema, { profile });
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
    });
  }
}
```

If your SDK uses its own converter, call that converter in the test and pass its output to `lintSchema`.

### Profiles describe an API mode

Rules reviewed October 1, 2026; ruleset `2026-10-01`.

| Profile                 | Scope                                                                            | Selected checks                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `openai-strict`         | Structured Outputs and strict function parameters, base models                   | Root object, required properties, closed objects, unsupported composition, documented size limits                       |
| `anthropic-json-output` | Claude native `output_config.format` JSON Schema; strict tools share this subset | Closed objects, unsupported bounds, recursive/external references, restricted regex constructs                          |
| `gemini-json-output`    | Gemini native Interactions `response_format.schema`                              | Findings for keywords outside the documented subset; supported unions, open maps and recursive references remain usable |

These scopes matter. Gemini's older `Schema`/`responseJsonSchema` surfaces and application-specific transforms have different behavior. OpenAI fine-tuned models have additional restrictions. This version does not model those modes. [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output?hl=en), [OpenAI supported schemas](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas).

See [provider rules and limitations](docs/provider-profiles.md) for source links, counting limits, and known gaps.

## Zod: make export failures visible

```ts
import { z } from 'zod';
import { lintZodSchema } from 'arkah-provider-schema-linter/zod';

const Report = z.strictObject({
  title: z.string(),
  note: z.string().nullable(),
});

const { jsonSchema, result } = lintZodSchema(Report, {
  profile: 'openai-strict',
  io: 'output',
});
```

The helper uses native Zod 4 `toJSONSchema`, targeting draft 2020-12, with output mode by default. It returns the exact exported `jsonSchema` alongside the lint result. If export throws, `jsonSchema` is absent and the result contains a `conversion.zod` error. Unsupported values are never replaced with `{}`.

Input and output are distinct contracts. A defaulted property can be optional on input and required on output; a plain `z.object` exports different object closure in those modes. Use `io: 'input'` when you need the pre-parse input contract, then inspect its findings. Defaults describe parser behavior and do not establish that a provider will insert them. [Zod JSON Schema documentation](https://zod.dev/json-schema).

A standalone transform usually cannot be exported in output mode; a pipeline with an explicit output schema can be representable. This helper does not execute transforms or validate their business logic. Native Zod export can evaluate dynamic default suppliers, so pass trusted authoring schemas to the helper. The raw `lintSchema` API only inspects JSON data. If your SDK uses another converter, export through that converter and call `lintSchema` directly.

## Keep repairable bounds out of the model's schema

A clean provider report means no configured check failed; it does not guarantee API acceptance. Length bounds also need an application policy: enforcement and SDK conversion vary, and output that exceeds a bound can fail strict parsing and trigger another model call. When shortening preserves the intended meaning, the `/emit` entry point lets you give the model the shape, keep the bounds in your storage schema, and join the two with a pure normalizer.

```ts
import { z } from 'zod';
import {
  assertEmitContract,
  defineEmitContract,
} from 'arkah-provider-schema-linter/emit';

const Summary = defineEmitContract({
  emit: z.strictObject({ title: z.string(), points: z.array(z.string()) }),
  strict: z.strictObject({
    title: z.string().min(1).max(80),
    points: z.array(z.string().min(1).max(200)).min(1).max(5),
  }),
  normalize: ({ title, points }) => ({
    title: title.trim().slice(0, 80),
    points: points
      .map((p) => p.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 5),
  }),
});

const summary = Summary.parse(modelJson); // overruns are trimmed, not retried

// Check every routed provider profile and normalize representative verbose samples.
assertEmitContract(Summary, {
  profiles: ['openai-strict', 'anthropic-json-output'],
  samples: [{ title: 'x'.repeat(500), points: Array(40).fill('a long point') }],
});
```

For plain JSON Schema, `lintLooseEmit(schema)` or the CLI flag `--loose-emit` reports `emit.prose-length-bound` and `emit.array-max-items` as warnings. These are application policy, kept apart from the evidence-backed provider rules. See [loose emit, strict normalize](docs/loose-emit.md) for when a cap is deliberate and what is intentionally not reported.

## CLI and CI

```sh
# Human-readable findings
node dist/cli.js --profile openai-strict examples/report-with-pitfalls.schema.json

# Stable JSON for automation
node dist/cli.js --profile anthropic-json-output --json examples/portable-report.schema.json

# Add loose-emit policy warnings for bounds that belong in normalization
node dist/cli.js --profile openai-strict --loose-emit examples/leaky-emit.schema.json

# Treat uncertain enforcement and incomplete analysis as a CI failure too
node dist/cli.js --profile gemini-json-output --warnings-as-errors examples/portable-report.schema.json

# A single JSON Schema via stdin; the dash is explicit
cat examples/portable-report.schema.json | node dist/cli.js --profile openai-strict --json -
```

After installing the package, use `pnpm exec provider-schema-lint` in place of `node dist/cli.js`. Pass the schema itself, not an API request envelope or a Zod JavaScript module. The CLI accepts one schema and one profile per invocation.

| Exit | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | No errors; warnings may still be present                                      |
| `1`  | At least one error, or a warning with `--warnings-as-errors`                  |
| `2`  | Invalid arguments, unreadable input, malformed JSON, or CLI input over 10 MiB |

`--json` writes a `LintResult` to stdout for linted schemas. Input/usage failures instead write `{ "error": { "code": "cli.input", "message": "…" } }` and exit `2`. `--help` and `--list-profiles` need no input.

## How the checker stays useful

**Walk schema positions, not arbitrary objects.** Values inside `default`, `enum`, `const`, and `examples` are data. A literal object there can contain a key named `type` or `$ref` without becoming a schema. The walker visits only schema-bearing keywords.

**Preserve precise locations.** Diagnostics use RFC 6901 JSON Pointers. A property named `a/b~c` appears as `/properties/a~1b~0c`; dots do not change its meaning. The root pointer is the empty string, displayed as `<root>` by the CLI.

**Resolve references locally.** Local pointer references are checked without fetching URLs. Recursive references are assessed against the selected profile. External and named-anchor references that cannot be fully analyzed produce findings instead of disappearing.

**Distinguish evidence from suspicion.** Documented incompatibilities are errors. Undocumented behavior and heuristics are warnings. For example, a closed object with no declared fields might be intentional, or a converter might have lost an open map. The linter cannot recover the author's intent, so that finding remains a warning.

**Bound the work.** The core rejects input beyond 50,000 JSON values, 128 syntactic levels, or 2,000,000 text characters. These are local resource limits, separate from provider limits. JavaScript object cycles are invalid JSON input; a recursive JSON Schema using `$ref` is a different case. No input mutation, reference fetching, or model calls occur.

The JSON result includes `schemaVersion: 1`, `rulesetVersion`, `profile`, and `diagnostics`. Import `lintResultSchema` to validate it, or `Diagnostic`, `LintResult`, `LintOptions`, and `ProfileId` for TypeScript types. Rule codes remain the integration surface; message wording may improve between releases. Ruleset changes can add findings, so pin package versions in CI.

## Development

```sh
pnpm verify
pnpm smoke:package
pnpm pack
```

Tests exercise exported builds, reference traversal, provider differences, conversion failures, emit contracts, and CLI exit codes. The package smoke test installs a fresh tarball in a temporary project and checks the installed CLI, ESM imports, Zod and emit helpers, and TypeScript declarations. CI is configured for Node 20, 22, and 24, with a separate weekly job against newer compatible Zod releases. See [CONTRIBUTING.md](CONTRIBUTING.md) for adding rules with primary-source evidence and synthetic fixtures.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities. MIT licensed. No provider affiliation or certification is implied.

## Background

Originally developed at [Arkah](https://arkah.io) to check schemas across structured-output providers.
