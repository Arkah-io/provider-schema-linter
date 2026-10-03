import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { z } from 'zod';
import {
  assertEmitContract,
  checkEmitContract,
  defineEmitContract,
  lintLooseEmit,
} from '../dist/emit.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const codes = (diagnostics) => diagnostics.map((d) => `${d.code} ${d.path}`);

test('published emit declarations preserve inferred normalizer and parser types', () => {
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      fileURLToPath(new URL('./emit.types.ts', import.meta.url)),
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('prose length bounds and array caps are policy warnings with exact paths', () => {
  const findings = lintLooseEmit({
    type: 'object',
    properties: {
      'a/b': { type: 'string', maxLength: 80 },
      points: {
        type: 'array',
        maxItems: 5,
        items: { type: ['string', 'null'], maxLength: 9 },
      },
    },
  });
  assert.deepEqual(codes(findings), [
    'emit.prose-length-bound /properties/a~1b',
    'emit.array-max-items /properties/points',
    'emit.prose-length-bound /properties/points/items',
  ]);
  assert.ok(findings.every((d) => d.severity === 'warning'));
});

test('closed vocabularies, formats, patterns, numbers and floors are not prose findings', () => {
  const findings = lintLooseEmit({
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'done'], maxLength: 4 },
      id: { type: 'string', pattern: '^[a-z]+$', maxLength: 12 },
      day: { type: 'string', format: 'date', maxLength: 10 },
      code: { const: 'x', maxLength: 1 },
      score: { type: 'integer', minimum: 1, maximum: 5, maxLength: 3 },
      title: { type: 'string', minLength: 1 },
      list: { type: 'array', minItems: 1, items: { type: 'string' } },
    },
    default: { title: { type: 'string', maxLength: 1 } },
  });
  assert.deepEqual(findings, []);
});

test('values inside enum, const and default are data, not schemas', () => {
  assert.deepEqual(
    lintLooseEmit({
      type: 'string',
      enum: [{ maxLength: 1 }],
      examples: [{ maxItems: 2 }],
    }),
    [],
  );
});

test('invalid JSON input is reported, not thrown', () => {
  assert.equal(lintLooseEmit({ bad: undefined })[0].severity, 'error');
});

test('loose policy does not prescribe truncation when referenced constraints disagree', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { $ref: '#/$defs/id', maxLength: 3 },
      integer: { $ref: '#/$defs/integer', maxLength: 3, maxItems: 2 },
      title: { $ref: '#/$defs/title', maxLength: 3 },
      points: { $ref: '#/$defs/points', maxItems: 2 },
    },
    $defs: {
      id: { type: 'string', pattern: '^[a-z]+$' },
      integer: { type: 'integer' },
      title: { type: 'string' },
      points: { type: 'array', items: { type: 'string' } },
    },
  };
  assert.deepEqual(codes(lintLooseEmit(schema)), [
    'emit.array-max-items /properties/points',
    'emit.prose-length-bound /properties/title',
  ]);
});

test('loose policy handles long aliases and recursive references without repeated expansion', () => {
  const definitions = { final: { type: 'string', format: 'uuid' } };
  for (let index = 0; index < 2000; index++)
    definitions[`p${index}`] = {
      $ref: index === 1999 ? '#/$defs/final' : `#/$defs/p${index + 1}`,
      maxLength: 10,
    };
  assert.deepEqual(lintLooseEmit({ $defs: definitions }), []);
  assert.deepEqual(lintLooseEmit({ $ref: '#', maxLength: 10 }), []);
});

test('invalid bounds only report syntax errors, and policy reports sort deterministically', () => {
  const findings = lintLooseEmit({
    type: 'array',
    maxItems: -1,
    items: { type: 'string', maxLength: 'wrong' },
  });
  assert.ok(
    findings.every((finding) => finding.code === 'schema.invalid-keyword'),
  );
  assert.deepEqual(
    findings.map((finding) => finding.path),
    ['/items/maxLength', '/maxItems'],
  );
});

const Summary = defineEmitContract({
  emit: z.strictObject({ title: z.string(), points: z.array(z.string()) }),
  strict: z.strictObject({
    title: z.string().min(1).max(20),
    points: z.array(z.string().min(1).max(30)).min(1).max(3),
  }),
  normalize: ({ title, points }) => ({
    title: title.trim().slice(0, 20),
    points: points
      .map((point) => point.trim().slice(0, 30))
      .filter(Boolean)
      .slice(0, 3),
  }),
});

test('parse absorbs verbose output and still rejects real contract failures', () => {
  const verbose = {
    title: '  A title that runs far past twenty characters  ',
    points: ['one', '', 'two', 'three', 'four', 'x'.repeat(90)],
  };
  assert.deepEqual(Summary.parse(verbose), {
    title: 'A title that runs fa',
    points: ['one', 'two', 'three'],
  });
  assert.throws(
    () => Summary.parse({ title: 'ok', points: 'not an array' }),
    z.ZodError,
  );
  assert.throws(
    () => Summary.parse({ title: '   ', points: ['a'] }),
    z.ZodError,
  );
  assert.ok(Object.isFrozen(Summary));
});

test('a clean contract passes on every routed provider with verbose samples', () => {
  const report = checkEmitContract(Summary, {
    profiles: ['openai-strict', 'anthropic-json-output', 'gemini-json-output'],
    samples: [
      { title: 'x'.repeat(500), points: Array(40).fill('long '.repeat(40)) },
    ],
  });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.deepEqual(
    report.providers.map((r) => r.profile),
    ['openai-strict', 'anthropic-json-output', 'gemini-json-output'],
  );
  assert.doesNotThrow(() =>
    assertEmitContract(Summary, { profiles: ['openai-strict'] }),
  );
});

test('one Zod export is shared by all provider and loose-policy checks', () => {
  let defaults = 0;
  const contract = defineEmitContract({
    emit: z.strictObject({
      title: z.string().default(() => String(++defaults)),
    }),
    strict: z.strictObject({ title: z.string() }),
    normalize: (value) => value,
  });
  const report = checkEmitContract(contract, {
    profiles: ['openai-strict', 'anthropic-json-output', 'gemini-json-output'],
  });
  assert.equal(defaults, 1);
  assert.equal(report.providers.length, 3);
});

test('sample failures preserve indexes and safely bound arbitrary thrown values', () => {
  const contract = defineEmitContract({
    emit: z.string(),
    strict: z.string(),
    normalize: (value) => {
      if (value === 'opaque') throw Object.create(null);
      if (value === 'long') throw 'x'.repeat(3000);
      if (value === 'error') throw new Error('normalizer failed');
      return value;
    },
  });
  const report = checkEmitContract(contract, {
    profiles: ['anthropic-json-output'],
    samples: ['ok', 'opaque', 'long', 'error'],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.sampleFailures.map((failure) => failure.index),
    [1, 2, 3],
  );
  assert.match(report.sampleFailures[0].message, /could not be described/);
  assert.equal(report.sampleFailures[1].message.length, 2000);
  assert.equal(report.sampleFailures[2].message, 'normalizer failed');
  const expected = new Error('identity');
  const throwing = defineEmitContract({
    emit: z.string(),
    strict: z.string(),
    normalize: () => {
      throw expected;
    },
  });
  assert.throws(
    () => throwing.parse('value'),
    (error) => error === expected,
  );
});

test('the synchronous contract rejects Promise normalization without leaking its rejection', async () => {
  const contract = defineEmitContract({
    emit: z.string(),
    strict: z.unknown(),
    normalize: async () => {
      throw new Error('async failure');
    },
  });
  const report = checkEmitContract(contract, {
    profiles: ['anthropic-json-output'],
    samples: ['value'],
  });
  assert.equal(report.ok, false);
  assert.match(
    report.sampleFailures[0].message,
    /normalize must be synchronous/,
  );
  // node:test also fails this test if a native Promise rejection escapes our handler.
  await new Promise((resolve) => setImmediate(resolve));
});

test('the synchronous contract rejects custom thenables without invoking them', () => {
  let calls = 0;
  const contract = defineEmitContract({
    emit: z.string(),
    strict: z.unknown(),
    normalize: () => ({
      then() {
        calls++;
      },
    }),
  });
  assert.throws(() => contract.parse('value'), /normalize must be synchronous/);
  assert.equal(calls, 0);
});

test('all options are validated before any export callbacks run', () => {
  let defaults = 0;
  const contract = defineEmitContract({
    emit: z.string().default(() => String(++defaults)),
    strict: z.string(),
    normalize: (value) => value,
  });
  for (const options of [
    { profiles: ['anthropic-json-output', 'unknown'] },
    { profiles: ['anthropic-json-output'], warningsAsErrors: 'true' },
    { profiles: ['anthropic-json-output'], io: 'unknown' },
    { profiles: ['anthropic-json-output'], extra: true },
  ])
    assert.throws(() => checkEmitContract(contract, options));
  assert.equal(defaults, 0);
});

test('putting strict bounds in the emit schema fails with provider and policy findings', () => {
  const Leaky = defineEmitContract({
    emit: z.strictObject({ title: z.string().max(20) }),
    strict: z.strictObject({ title: z.string().max(20) }),
    normalize: (value) => value,
  });
  const report = checkEmitContract(Leaky, {
    profiles: ['openai-strict', 'anthropic-json-output'],
    samples: [{ title: 'x'.repeat(21) }],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report.looseEmit), [
    'emit.prose-length-bound /properties/title',
  ]);
  assert.ok(
    report.providers[1].diagnostics.some(
      (d) => d.code === 'anthropic.unsupported-keyword',
    ),
  );
  assert.deepEqual(
    report.sampleFailures.map((f) => f.index),
    [0],
  );
  assert.throws(
    () => assertEmitContract(Leaky, { profiles: ['anthropic-json-output'] }),
    /loose-emit warning emit\.prose-length-bound \/properties\/title/,
  );
});

test('warnings alone pass unless warningsAsErrors is set', () => {
  const Capped = defineEmitContract({
    emit: z.strictObject({ tags: z.array(z.enum(['a', 'b'])).max(2) }),
    strict: z.strictObject({ tags: z.array(z.enum(['a', 'b'])).max(2) }),
    normalize: ({ tags }) => ({ tags: tags.slice(0, 2) }),
  });
  assert.equal(
    checkEmitContract(Capped, { profiles: ['openai-strict'] }).ok,
    true,
  );
  assert.equal(
    checkEmitContract(Capped, {
      profiles: ['openai-strict'],
      warningsAsErrors: true,
    }).ok,
    false,
  );
  assert.throws(
    () => checkEmitContract(Capped, { profiles: [] }),
    /at least one/,
  );
});

test('an emit schema Zod cannot export is a provider error, with no policy pass', () => {
  const Transformed = defineEmitContract({
    emit: z.string().transform((value) => value.trim()),
    strict: z.string(),
    normalize: (value) => value,
  });
  const report = checkEmitContract(Transformed, {
    profiles: ['openai-strict'],
  });
  assert.equal(report.ok, false);
  assert.equal(report.providers[0].diagnostics[0].code, 'conversion.zod');
  assert.deepEqual(report.looseEmit, []);
});

test('CLI --loose-emit merges sorted policy warnings into the provider report', () => {
  const schema = JSON.stringify({
    type: 'object',
    properties: { title: { type: 'string', maxLength: 80 } },
    required: ['title'],
    additionalProperties: false,
  });
  const run = (...flags) =>
    spawnSync(
      process.execPath,
      [cli, '--profile', 'openai-strict', '--json', ...flags, '-'],
      {
        input: schema,
        encoding: 'utf8',
      },
    );
  const plain = JSON.parse(run().stdout);
  const loose = run('--loose-emit');
  const report = JSON.parse(loose.stdout);
  assert.equal(loose.status, 0);
  assert.ok(!plain.diagnostics.some((d) => d.code.startsWith('emit.')));
  assert.deepEqual(
    report.diagnostics.map((d) => d.code),
    [...plain.diagnostics.map((d) => d.code), 'emit.prose-length-bound'].sort(
      (a, b) => (a < b ? -1 : 1),
    ),
  );
  assert.equal(run('--loose-emit', '--warnings-as-errors').status, 1);
});
