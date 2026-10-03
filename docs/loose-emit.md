# Loose emit, strict normalize

The provider profiles catch known schema incompatibilities and flag undocumented support. A clean report does not guarantee API acceptance. This page covers a separate application policy: **which constraints belong in the schema the model sees, and which can your code handle after generation?**

## Length limits and repair loops

Suppose a title must be at most 80 characters, and that bound sits in the schema sent to the model:

```ts
z.strictObject({ title: z.string().max(80) });
```

Provider enforcement and SDK conversion affect what happens to that bound:

| Where the bound ends up                   | What to account for                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Enforced during constrained generation    | The model must produce text within the bound; this can affect wording. |
| Rejected by the endpoint                  | The request fails before usable output is generated.                   |
| Not enforced, or removed by an SDK helper | Output may exceed the bound and fail a later strict parse.             |
| Outside the documented subset             | Acceptance and enforcement need verification for the chosen endpoint.  |

If your application responds to a length overrun with another model call, it can spend time and tokens shortening otherwise useful text. Deterministic normalization can avoid that retry when shortening is acceptable for your product. Some content must remain complete; retain its constraint or report a validation failure when truncation would lose meaning.

## Two schemas and a pure function

Give the model an exportable shape. Keep the durable contract for storage and rendering, and join them with a synchronous, deterministic normalizer:

```ts
import { z } from 'zod';
import { defineEmitContract } from 'arkah-provider-schema-linter/emit';

export const Summary = defineEmitContract({
  // What the model sees: shape, required fields, closed objects, enums.
  emit: z.strictObject({
    title: z.string(),
    points: z.array(z.string()),
  }),
  // What you persist: the real bounds.
  strict: z.strictObject({
    title: z.string().min(1).max(80),
    points: z.array(z.string().min(1).max(200)).min(1).max(5),
  }),
  // The bridge: trim, truncate, drop empties, cap counts. Never a model call.
  normalize: ({ title, points }) => ({
    title: title.trim().slice(0, 80).trimEnd(),
    points: points
      .map((point) => point.trim().slice(0, 200).trimEnd())
      .filter(Boolean)
      .slice(0, 5),
  }),
});

const summary = Summary.parse(JSON.parse(modelText));
```

`parse` runs `emit.parse`, then `normalize`, then `strict.parse`. Validation failures remain `ZodError`s; exceptions thrown by your normalizer propagate unchanged. In this example, verbose valid input is shortened, while an empty title or an empty points list still fails. Choose recovery based on the failure: a normalizer bug needs a code fix, not another model call.

Keep structural decisions in the emit schema: field types, required fields, closed objects, and enums. Use unions, formats, and other constraints only where the selected provider profile supports them. Move shortening, item selection, whitespace cleanup, deduplication, or clamping into `normalize` only when those changes preserve your intended meaning.

Truncation is a product decision. JavaScript `slice` is simple but can split words or Unicode characters. Word, sentence, or grapheme boundaries may suit your UI better. The helper does not choose that policy or enforce normalizer purity.

Keep the emit schema free of transforms so its exported JSON shape matches the raw data that `emit.parse` accepts. A transform with an explicit output schema can export successfully while describing a different shape from its input. Prefer transforms in the normalizer or strict schema. `io: 'input'` and `io: 'output'` select the Zod export side; neither proves that your SDK sends an identical schema.

## Test it once per call

```ts
import { test } from 'node:test'; // or vitest
import { assertEmitContract } from 'arkah-provider-schema-linter/emit';
import { Summary } from './summary.js';

test('summary emit contract', () => {
  assertEmitContract(Summary, {
    // Every provider this call can reach, including fallbacks.
    profiles: ['openai-strict', 'anthropic-json-output'],
    // Check representative verbose input against this normalizer.
    samples: [
      { title: 'x'.repeat(500), points: Array(40).fill('a long point') },
    ],
  });
});
```

The check fails when:

- the exported emit schema has a provider **error** on any listed profile, including a Zod export failure;
- a sample does not survive `parse`;
- with `warningsAsErrors: true`, any warning remains, including the policy findings below.

`checkEmitContract` returns the same findings instead of asserting success. It exports the emit schema once and shares that snapshot across all requested profiles and the policy checks. Native Zod export can evaluate dynamic default suppliers. Parsing samples also executes your Zod callbacks and normalizer; these are trusted application code.

`sampleFailures` lists failed sample indexes and messages capped at 2,000 characters, including errors thrown by the normalizer. Invalid check options throw before export starts. An empty sample list checks schemas only. `ok: true` means no configured check failed; it does not prove provider acceptance or correctness for inputs you did not test.

## Policy findings

`lintLooseEmit(jsonSchema)`, `assertEmitContract`, and the CLI flag `--loose-emit` report:

| Code                      | Finding                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `emit.prose-length-bound` | `maxLength` on a free-text candidate without `enum`, `const`, `pattern`, or `format` |
| `emit.array-max-items`    | `maxItems` on an emitted array                                                       |

Both are warnings. Some caps are deliberate. Enforcing an item limit during generation may be preferable to dropping items afterward. These rules make no provider rejection claim and are opt-in through `/emit` or `--loose-emit`; the normal `lintSchema` API reports provider findings only.

The rules inspect schema locations, not objects inside `enum`, `const`, `default`, or `examples`. Resolved local reference constraints inform classification. Unresolved references, reference-only cycles, and composition envelopes are not classified as free text or arrays; their individual branches are still inspected. This is a conservative heuristic, not complete JSON Schema evaluation. Malformed bounds receive syntax diagnostics rather than normalization advice.

These policy rules do not flag `minLength`, `minItems`, numeric bounds, or strings with a closed vocabulary or format. Such constraints may carry semantics, such as a 1–5 score. The separate provider profiles can still report them as unsupported or undocumented.

## What this does not do

This module does not rewrite schemas, generate normalizers, call providers, or decide which content may be discarded. `lintLooseEmit` reads JSON data only. `defineEmitContract` and sample checks execute your parsing and normalization code.

The contract API is synchronous. It rejects Promise/thenable values returned by parsing or normalization, and handles native Promise rejections that it observes. Use synchronous Zod schemas too: an async refinement can start work inside Zod before synchronous parsing rejects it, and this helper cannot intercept a Promise that Zod does not return. Use a separate asynchronous validation flow if your contract needs asynchronous work.
