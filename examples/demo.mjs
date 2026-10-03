import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { lintSchema, PROFILE_IDS } from 'arkah-provider-schema-linter';
import { lintZodSchema } from 'arkah-provider-schema-linter/zod';
import {
  assertEmitContract,
  defineEmitContract,
  lintLooseEmit,
} from 'arkah-provider-schema-linter/emit';

const load = async (name) =>
  JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const portable = await load('./portable-report.schema.json');
const pitfalls = await load('./report-with-pitfalls.schema.json');

for (const [name, schema] of [
  ['Portable report', portable],
  ['Report with pitfalls', pitfalls],
]) {
  console.log(`\n${name}`);
  for (const profile of PROFILE_IDS) {
    const result = lintSchema(schema, { profile });
    const errors = result.diagnostics.filter(
      (d) => d.severity === 'error',
    ).length;
    console.log(
      `  ${profile}: ${errors} errors, ${result.diagnostics.length - errors} warnings`,
    );
    if (name === 'Portable report') assert.equal(result.diagnostics.length, 0);
    for (const finding of result.diagnostics) {
      console.log(
        `    ${finding.code} ${finding.path || '<root>'}: ${finding.message}`,
      );
    }
  }
}

console.log(
  '\nExport before linting: optional and nullable have different contracts',
);
const optional = lintZodSchema(
  z.strictObject({ note: z.string().optional() }),
  { profile: 'openai-strict' },
);
const nullable = lintZodSchema(
  z.strictObject({ note: z.string().nullable() }),
  { profile: 'openai-strict' },
);
assert.ok(optional.result.diagnostics.some((d) => d.severity === 'error'));
assert.equal(nullable.result.diagnostics.length, 0);
console.log(
  `  Optional note: ${optional.result.diagnostics.length} finding(s)`,
);
console.log(
  `  Required nullable note: ${nullable.result.diagnostics.length} finding(s)`,
);

const transformed = lintZodSchema(
  z.string().transform((value) => value.trim()),
  { profile: 'openai-strict' },
);
assert.equal(transformed.result.diagnostics[0].code, 'conversion.zod');
assert.equal(transformed.jsonSchema, undefined);
console.log(
  `  Transform without an exportable output schema: ${transformed.result.diagnostics[0].code}`,
);
console.log(
  '\nLoose emit, strict normalize: overruns are trimmed, not retried',
);
const Summary = defineEmitContract({
  emit: z.strictObject({ title: z.string(), points: z.array(z.string()) }),
  strict: z.strictObject({
    title: z.string().min(1).max(24),
    points: z.array(z.string().min(1)).min(1).max(2),
  }),
  normalize: ({ title, points }) => ({
    title: title.trim().slice(0, 24).trimEnd(),
    points: points
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 2),
  }),
});
const verbose = {
  title: 'A title the model wrote a little too long',
  points: ['First', '', 'Second', 'Third'],
};
assert.deepEqual(Summary.parse(verbose), {
  title: 'A title the model wrote',
  points: ['First', 'Second'],
});
assertEmitContract(Summary, {
  profiles: PROFILE_IDS,
  samples: [verbose],
});
console.log(`  Normalized: ${JSON.stringify(Summary.parse(verbose))}`);
const leaky = lintLooseEmit(await load('./leaky-emit.schema.json'));
assert.equal(leaky.length, 3);
console.log(
  `  Leaky emit schema: ${leaky.length} loose-emit warning(s): ${leaky.map((d) => `${d.code} ${d.path}`).join(', ')}`,
);

console.log(
  '\nNo model calls, credentials, or private application schemas used.',
);
