# Changelog

## 0.1.0 — 2026-10-03

- Profiles `openai-strict`, `anthropic-json-output` and `gemini-json-output`, ruleset `2026-10-01`.
- `lintSchema` with RFC 6901 paths, source links, local `$ref` resolution and bounded work.
- `lintZodSchema` (subpath `/zod`) using Zod 4's native exporter; conversion failures are reported, never erased.
- `provider-schema-lint` CLI with `--json`, `--warnings-as-errors` and stable exit codes.
- `/emit` subpath: `defineEmitContract`, `checkEmitContract`, `assertEmitContract` and `lintLooseEmit` for the loose-emit, strict-normalize pattern. Policy warnings `emit.prose-length-bound` and `emit.array-max-items`, kept separate from provider rules.
- CLI flag `--loose-emit`.
- Zod is a peer dependency (`^4.6.5`).

- Single schema export per emit-contract check, synchronous normalizer enforcement, safe conversion-error reporting, and reference-aware loose-emit diagnostics.
- Clean-install coverage for the public API, CLI, Zod and emit entry points.
