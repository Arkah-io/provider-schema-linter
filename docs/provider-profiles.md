# Provider profiles and evidence

Ruleset: `2026-10-01`. Checked against official documentation on October 1, 2026. This linter performs selected structural and provider checks; it is not a complete JSON Schema validator or a provider emulator.

## OpenAI strict

Scope: the JSON Schema supplied to Structured Outputs or strict function parameters on supported base models. Fine-tuned model restrictions are outside this profile.

The [supported schema subset](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas) requires an object root, forbids root `anyOf`, requires all declared fields, and requires `additionalProperties: false` on objects. Nested `anyOf`, definitions, and recursive references are supported. [Strict function calling](https://developers.openai.com/api/docs/guides/function-calling#strict-mode) uses the same subset.

Documented limits include 5,000 total object properties, ten nesting levels, 1,000 enum members across the schema, and 120,000 characters across property names, definition names, string enum members, and string constants. A single string enum with more than 250 members has a 15,000-character limit. These counts inspect schema declarations; this tool does not try to count an infinite recursive expansion.

Explicitly excluded composition keywords are errors. Unlisted keywords receive cautious findings rather than invented rejection guarantees. In particular, the documentation lists `anyOf` but does not specify `oneOf` in the same way, and its discussion of string lengths differs between the base and fine-tuned sections. Those cases remain warnings.

Supported base-model numeric bounds and array length bounds must not be rejected merely because an application prefers loose generation schemas. Rules in this package describe the provider boundary, not a policy about prose length or retries.

## Anthropic JSON output

Scope: Claude's native `output_config.format` JSON Schema. The [JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations) also apply to strict tool inputs.

Objects must be closed. Optional properties are allowed. Internal references and supported union forms are usable; recursive and external references are excluded. Numeric bounds, string length bounds, and most array constraints are excluded; the documented `minItems` exception allows 0 or 1. Regular expressions have a restricted syntax. The linter detects specified unsupported constructs; it does not implement the provider's full regex compiler.

Anthropic SDK helpers may remove unsupported constraints before transmission and apply stronger validation afterward. Check that transmitted schema if you use such a helper. A native Zod export with a bound can correctly produce a lint error even when an SDK's transformed export passes.

The provider also has request-wide limits involving strict tools, optional parameters, and union parameters. The linter reports a schema whose declared optional fields or union fields alone exceed the documented totals. It counts each declaration once, without expanding shared references into repeated field instances. A single-schema API cannot evaluate an entire combined request, so this version does not guarantee those budgets or grammar-compilation complexity.

## Gemini JSON output

Scope: the current native Interactions API's `response_format.schema`, as described in the [structured output guide](https://ai.google.dev/gemini-api/docs/structured-output?hl=en).

The guide demonstrates nested object unions, open dictionaries, and recursive references. Numeric bounds and array bounds are in its documented subset. A keyword outside that subset produces a warning about uncertain support or enforcement. This profile does not claim every such keyword causes an HTTP error or is silently ignored.

The older [GenerateContent reference](https://ai.google.dev/api/generate-content) describes different `responseJsonSchema` and legacy `Schema` behavior. Private adapter transformations can differ again. This profile does not apply those restrictions to the current native surface and does not strip keywords to imitate an SDK.

## Common checks and known boundaries

- The input must be JSON data: objects, arrays, finite numbers, booleans, null, and strings. Actual JavaScript cycles cannot be serialized as JSON.
- The checker visits schema-bearing positions. Annotation and literal data are not recursively interpreted as schemas.
- JSON Pointer references are resolved locally. Remote fetching and arbitrary module loading are absent.
- Unknown keywords and incomplete reference analysis remain visible. A lint result is not a complete dialect validation result.
- The checker recognizes `$schema` as dialect metadata without certifying that every provider endpoint accepts that field. Check your adapter's final export.
- Empty closed objects are a heuristic warning because converter data loss and intentional emptiness are indistinguishable here.
- Parser defaults and transforms are application behavior. The raw JSON linter does not execute them or establish that a provider implements them. The optional native Zod exporter can evaluate dynamic default suppliers; pass trusted authoring schemas to that helper.
- Local complexity limits can reject a schema before all provider checks run. An error result never certifies that every possible defect was reported.
