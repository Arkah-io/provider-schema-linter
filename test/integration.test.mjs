import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { lintSchema, lintResultSchema, PROFILE_IDS } from '../dist/index.js';
import { lintZodSchema } from '../dist/zod.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const portableFile = fileURLToPath(
  new URL('../examples/portable-report.schema.json', import.meta.url),
);
const run = (args, input) =>
  spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: 'utf8',
    timeout: 10_000,
  });
const profile = ['--profile', 'openai-strict'];
const portable = {
  type: 'object',
  properties: { note: { type: ['string', 'null'] } },
  required: ['note'],
  additionalProperties: false,
};

test('the built CLI reads files and emits the public versioned contract', () => {
  const output = run([...profile, '--json', portableFile]);
  assert.equal(output.status, 0, output.stderr);
  const result = lintResultSchema.parse(JSON.parse(output.stdout));
  assert.deepEqual(
    result,
    lintSchema(JSON.parse(readFileSync(portableFile, 'utf8')), {
      profile: 'openai-strict',
    }),
  );
  assert.deepEqual(result.diagnostics, []);
});

test('stdin findings exit 1; schema paths are JSON Pointers', () => {
  const invalid = {
    ...portable,
    properties: { 'note/~': { type: 'object', properties: {} } },
    required: ['note/~'],
  };
  const output = run([...profile, '--json', '-'], JSON.stringify(invalid));
  assert.equal(output.status, 1, output.stderr);
  const result = lintResultSchema.parse(JSON.parse(output.stdout));
  assert.ok(
    result.diagnostics.some((d) => d.path.startsWith('/properties/note~1~0')),
  );
});

test('warnings remain visible and can fail CI explicitly', () => {
  const empty = JSON.stringify({
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  const normal = run([...profile, '--json', '-'], empty);
  assert.equal(normal.status, 0, normal.stdout);
  assert.ok(
    JSON.parse(normal.stdout).diagnostics.some((d) => d.severity === 'warning'),
  );
  assert.equal(run([...profile, '--warnings-as-errors', '-'], empty).status, 1);
});

test('invalid JSON, missing files and malformed invocations exit 2', () => {
  for (const [args, input] of [
    [[...profile, '--json', '-'], '{'],
    [
      [...profile, '--json', '/nonexistent-provider-schema-test/schema.json'],
      undefined,
    ],
    [['--profile', 'wrong', '--json', '-'], '{}'],
    [['--json', '-'], '{}'],
    [[...profile, '--json'], undefined],
    [[...profile, '--json', '--surprise', '-'], '{}'],
    [[...profile, '--json', 'a.json', 'b.json'], undefined],
    [[...profile, '--profile', 'openai-strict', '--json', '-'], '{}'],
  ]) {
    const output = run(args, input);
    assert.equal(output.status, 2, `${args}: ${output.stderr}`);
    assert.equal(JSON.parse(output.stdout).error.code, 'cli.input');
  }
});

test('help and profile discovery do not wait for stdin', () => {
  assert.match(run(['--help']).stdout, /Exit status/);
  assert.deepEqual(run(['--list-profiles']).stdout.trim().split('\n'), [
    ...PROFILE_IDS,
  ]);
});

test('CLI rejects malformed UTF-8 instead of substituting schema characters', () => {
  const input = Buffer.concat([
    Buffer.from('{"type":"string","description":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  const output = run([...profile, '--json', '-'], input);
  assert.equal(output.status, 2, output.stdout);
  assert.equal(JSON.parse(output.stdout).error.code, 'cli.input');
});

test('CLI rejects oversized input and escapes terminal control bytes in findings', () => {
  const oversized = run(
    [...profile, '--json', '-'],
    ' '.repeat(10 * 1024 * 1024 + 1),
  );
  assert.equal(oversized.status, 2, oversized.stderr);
  const input = {
    ...portable,
    properties: { '\u001b[31munsafe': {} },
    required: [],
  };
  const output = run([...profile, '-'], JSON.stringify(input));
  assert.equal(output.status, 1);
  assert.ok(!output.stdout.includes('\u001b'));
});

test('native Zod conversion retains optionality and nullable semantics', () => {
  const optional = lintZodSchema(
    z.strictObject({ note: z.string().optional() }),
    { profile: 'openai-strict' },
  );
  const nullable = lintZodSchema(
    z.strictObject({ note: z.string().nullable() }),
    { profile: 'openai-strict' },
  );
  assert.ok(optional.result.diagnostics.some((d) => d.severity === 'error'));
  assert.deepEqual(nullable.jsonSchema.properties.note.type, [
    'string',
    'null',
  ]);
  assert.deepEqual(nullable.result.diagnostics, []);
  lintResultSchema.parse(nullable.result);
});

test('conversion errors remain visible without substituting an empty schema', () => {
  let executions = 0;
  const schema = z.string().transform((value) => {
    executions++;
    return value.trim();
  });
  const output = lintZodSchema(schema, { profile: 'openai-strict' });
  assert.equal(executions, 0);
  assert.equal(output.jsonSchema, undefined);
  assert.equal(output.result.diagnostics[0].code, 'conversion.zod');
  assert.equal(output.result.diagnostics[0].severity, 'error');
  lintResultSchema.parse(output.result);
});

test('Zod input and output exports make defaults and object closure explicit', () => {
  const schema = z.object({ note: z.string().default('') });
  const output = lintZodSchema(schema, {
    profile: 'openai-strict',
    io: 'output',
  });
  const input = lintZodSchema(schema, {
    profile: 'openai-strict',
    io: 'input',
  });
  assert.deepEqual(output.jsonSchema.required, ['note']);
  assert.equal(output.jsonSchema.additionalProperties, false);
  assert.equal(input.jsonSchema.required, undefined);
  assert.equal(input.jsonSchema.additionalProperties, undefined);
  assert.ok(input.result.diagnostics.some((d) => d.severity === 'error'));
});

test('explicit output schemas after a transform can be exported without running it', () => {
  const schema = z
    .string()
    .transform((text) => Number(text))
    .pipe(z.number());
  const output = lintZodSchema(z.strictObject({ count: schema }), {
    profile: 'openai-strict',
  });
  assert.equal(output.jsonSchema.properties.count.type, 'number');
  assert.ok(
    !output.result.diagnostics.some((d) => d.code === 'conversion.zod'),
  );
});

test('Zod options reject invalid profiles instead of guessing a provider', () => {
  assert.throws(() => lintZodSchema(z.string(), { profile: 'openai' }));
});

test('native Zod export can evaluate dynamic default suppliers', () => {
  let defaults = 0;
  const schema = z.strictObject({
    count: z.number().default(() => {
      defaults++;
      return 1;
    }),
  });
  const output = lintZodSchema(schema, { profile: 'openai-strict' });
  assert.equal(defaults, 1);
  assert.equal(output.jsonSchema.properties.count.default, 1);
});

test('conversion callback errors remain reports even when their message cannot be read', () => {
  const failure = new Error('placeholder');
  Object.defineProperty(failure, 'message', {
    get() {
      throw new Error('message failed');
    },
  });
  const schema = z.string().default(() => {
    throw failure;
  });
  const report = lintZodSchema(schema, { profile: 'anthropic-json-output' });
  assert.equal(report.jsonSchema, undefined);
  assert.equal(report.result.diagnostics[0].code, 'conversion.zod');
  assert.match(
    report.result.diagnostics[0].message,
    /message could not be read/,
  );
  const long = lintZodSchema(
    z.string().default(() => {
      throw 'x'.repeat(5000);
    }),
    { profile: 'anthropic-json-output' },
  );
  assert.ok(long.result.diagnostics[0].message.length < 1100);
});
