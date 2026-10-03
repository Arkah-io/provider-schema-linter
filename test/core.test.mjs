import assert from 'node:assert/strict';
import test from 'node:test';
import { lintSchema, lintResultSchema, PROFILE_IDS } from '../dist/index.js';

const object = (properties = {}, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const lint = (schema, profile = 'openai-strict') =>
  lintSchema(schema, { profile }).diagnostics;
const codes = (schema, profile) =>
  lint(schema, profile).map((finding) => finding.code);
const errors = (schema, profile) =>
  lint(schema, profile).filter((finding) => finding.severity === 'error');

test('a small portable exported schema is clean in each explicit mode', () => {
  const schema = object({
    title: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  });
  for (const profile of PROFILE_IDS)
    assert.deepEqual(lint(schema, profile), []);
});

test('results follow the public versioned contract and all diagnostics carry sources', () => {
  const result = lintSchema(object({ title: { type: 'string' } }, []), {
    profile: 'openai-strict',
  });
  assert.deepEqual(lintResultSchema.parse(result), result);
  assert.equal(result.schemaVersion, 1);
  assert.match(result.rulesetVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    result.diagnostics.every((finding) =>
      finding.source.startsWith('https://'),
    ),
  );
});

test('input is unchanged and frozen inputs are supported', () => {
  const schema = object({ title: { type: 'string', maxLength: 20 } });
  const snapshot = JSON.stringify(schema);
  Object.freeze(schema.properties.title);
  Object.freeze(schema.properties);
  Object.freeze(schema);
  lint(schema);
  assert.equal(JSON.stringify(schema), snapshot);
});

test('enum, default and example objects are data, not nested schemas', () => {
  const literal = { properties: 'invalid', required: 5, $ref: '#/not-a-ref' };
  const schema = object({
    value: { enum: [literal], default: literal, examples: [literal] },
  });
  assert.deepEqual(errors(schema), []);
  assert.ok(
    lint(schema).every((finding) =>
      ['/properties/value/default', '/properties/value/examples'].includes(
        finding.path,
      ),
    ),
  );
});

test('unknown extension data is not traversed as schema', () => {
  const schema = object({
    name: {
      type: 'string',
      'x-editor': { type: 'invalid', $ref: '#/missing' },
    },
  });
  assert.deepEqual(codes(schema), ['openai.undocumented-keyword']);
});

test('property diagnostics use RFC 6901 escapes', () => {
  const schema = object({
    'a/b~c': { type: 'object', properties: { answer: { type: 'string' } } },
  });
  const result = lint(schema);
  assert.ok(
    result.some((finding) => finding.path === '/properties/a~1b~0c/required'),
  );
});

test('local refs resolve escaped keys and percent-encoded fragments', () => {
  const schema = object({ item: { $ref: '#/$defs/a~1b~0%20c' } });
  schema.$defs = { 'a/b~ c': { type: 'string' } };
  assert.deepEqual(lint(schema), []);
});

test('OpenAI local recursion is supported without infinite expansion', () => {
  const schema = object({ children: { type: 'array', items: { $ref: '#' } } });
  assert.deepEqual(lint(schema), []);
});

test('OpenAI named recursive definitions are supported', () => {
  const schema = object({ node: { $ref: '#/$defs/node' } });
  schema.$defs = {
    node: object({
      next: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] },
    }),
  };
  assert.deepEqual(lint(schema), []);
});

test('Anthropic rejects recursive refs with a source-linked provider error', () => {
  const schema = object({ children: { type: 'array', items: { $ref: '#' } } });
  assert.ok(
    lint(schema, 'anthropic-json-output').some(
      (finding) =>
        finding.code === 'anthropic.recursive-reference' &&
        finding.severity === 'error',
    ),
  );
});

test('shared acyclic refs are not mistaken for recursion', () => {
  const schema = object({
    first: { $ref: '#/$defs/name' },
    second: { $ref: '#/$defs/name' },
  });
  schema.$defs = { name: { type: 'string' } };
  assert.deepEqual(lint(schema, 'anthropic-json-output'), []);
});

test('an unused definition referring to a root that never references it is not a recursive cycle', () => {
  const schema = object({ name: { type: 'string' } });
  schema.$defs = { root: { $ref: '#' } };
  assert.ok(
    !codes(schema, 'anthropic-json-output').includes(
      'anthropic.recursive-reference',
    ),
  );
});

test('unresolved, malformed and literal-data refs are diagnosed', () => {
  for (const reference of ['#/$defs/missing', '#/examples/0']) {
    const schema = object({ value: { $ref: reference } });
    schema.examples = [{ type: 'string' }];
    assert.ok(codes(schema).includes('reference.unresolved'));
  }
  for (const reference of ['#/bad~2name', '#/%ZZ']) {
    assert.ok(
      codes(object({ value: { $ref: reference } })).includes(
        'reference.invalid-pointer',
      ),
    );
  }
});

test('external refs and anchors report incomplete analysis without network access', () => {
  assert.ok(
    codes(
      object({ value: { $ref: 'https://example.invalid/schema' } }),
    ).includes('reference.external'),
  );
  assert.ok(
    codes(object({ value: { $ref: '#entry' } })).includes('reference.anchor'),
  );
  assert.ok(
    codes(
      object({ value: { $ref: 'https://example.invalid/schema' } }),
      'anthropic-json-output',
    ).includes('anthropic.external-reference'),
  );
});

test('nested resource scopes are not incorrectly resolved against the document root', () => {
  const schema = object({
    value: { $id: 'https://example.invalid/resource', $ref: '#/$defs/value' },
  });
  schema.$defs = { value: { type: 'string' } };
  assert.ok(codes(schema).includes('reference.scoped-id'));
  assert.ok(!codes(schema).includes('reference.unresolved'));
});

test('dynamic refs report incomplete reference analysis', () => {
  assert.ok(
    codes(object({ value: { $dynamicRef: '#entry' } })).includes(
      'reference.dynamic',
    ),
  );
});

test('own __proto__ names are safe and not confused with inherited properties', () => {
  const schema = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}',
  );
  assert.deepEqual(lint(schema), []);
  assert.equal({}.polluted, undefined);
});

test('OpenAI optional-field checking is independent of object closure', () => {
  const schema = { type: 'object', properties: { value: { type: 'string' } } };
  assert.ok(codes(schema).includes('openai.required-properties'));
  assert.ok(codes(schema).includes('openai.additional-properties'));
});

test('nullable required fields work in OpenAI mode', () => {
  assert.deepEqual(lint(object({ value: { type: ['string', 'null'] } })), []);
});

test('Anthropic permits optional fields but still requires closed objects', () => {
  assert.deepEqual(
    lint(object({ name: { type: 'string' } }, []), 'anthropic-json-output'),
    [],
  );
  assert.ok(
    codes(
      { type: 'object', properties: { name: { type: 'string' } } },
      'anthropic-json-output',
    ).includes('anthropic.additional-properties'),
  );
});

test('an intentionally empty closed object is a warning, not a provider error', () => {
  assert.deepEqual(errors(object()), []);
  assert.ok(codes(object()).includes('heuristic.empty-object'));
});

test('Gemini accepts open maps and object anyOf branches on the scoped native output surface', () => {
  const schema = {
    type: 'object',
    properties: {
      value: {
        anyOf: [
          {
            type: 'object',
            properties: { name: { type: 'string' } },
            additionalProperties: true,
          },
          { type: 'string' },
        ],
      },
    },
    additionalProperties: { type: 'number' },
  };
  assert.deepEqual(lint(schema, 'gemini-json-output'), []);
});

test('Gemini accepts root recursion and tuple prefixItems', () => {
  assert.deepEqual(
    lint(
      object({ children: { type: 'array', items: { $ref: '#' } } }),
      'gemini-json-output',
    ),
    [],
  );
  assert.deepEqual(
    lint(
      {
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'number' }],
        minItems: 2,
        maxItems: 2,
      },
      'gemini-json-output',
    ),
    [],
  );
});

test('documented unsupported constraints are errors; undocumented support is a warning', () => {
  const schema = object({ value: { type: 'string', minLength: 1 } });
  assert.ok(
    lint(schema, 'anthropic-json-output').some(
      (finding) =>
        finding.code === 'anthropic.unsupported-keyword' &&
        finding.severity === 'error',
    ),
  );
  for (const profile of ['openai-strict', 'gemini-json-output']) {
    assert.ok(
      lint(schema, profile).some(
        (finding) =>
          finding.code.endsWith('.undocumented-keyword') &&
          finding.severity === 'warning',
      ),
    );
    assert.deepEqual(errors(schema, profile), []);
  }
});

test('base OpenAI numeric bounds remain supported', () => {
  assert.deepEqual(
    lint(
      object({
        score: { type: 'number', minimum: 0, maximum: 10, multipleOf: 0.5 },
      }),
    ),
    [],
  );
});

test('Anthropic minItems only permits zero or one', () => {
  for (const minItems of [0, 1])
    assert.deepEqual(
      lint(
        { type: 'array', items: { type: 'string' }, minItems },
        'anthropic-json-output',
      ),
      [],
    );
  assert.ok(
    codes(
      { type: 'array', items: { type: 'string' }, minItems: 2 },
      'anthropic-json-output',
    ).includes('anthropic.min-items'),
  );
});

test('root anyOf is an OpenAI error while nested anyOf is supported', () => {
  assert.ok(
    codes({
      anyOf: [
        object({ a: { type: 'string' } }),
        object({ b: { type: 'number' } }),
      ],
    }).includes('openai.root-anyof'),
  );
  assert.deepEqual(
    lint(
      object({ value: { anyOf: [{ type: 'number' }, { type: 'string' }] } }),
    ),
    [],
  );
});

test('explicitly unsupported OpenAI composition is distinguished from undocumented oneOf', () => {
  assert.ok(
    codes(object({ value: { allOf: [{ type: 'string' }] } })).includes(
      'openai.unsupported-keyword',
    ),
  );
  const result = lint(
    object({ value: { oneOf: [{ type: 'string' }, { type: 'number' }] } }),
  );
  assert.ok(
    result.some(
      (finding) =>
        finding.code === 'openai.undocumented-keyword' &&
        finding.severity === 'warning',
    ),
  );
  assert.ok(!result.some((finding) => finding.severity === 'error'));
});

test('ref description siblings are not rejected by unsupported historical assumptions', () => {
  const schema = object({
    value: { $ref: '#/$defs/value', description: 'A value.' },
  });
  schema.$defs = { value: { type: 'string' } };
  assert.deepEqual(lint(schema), []);
});

test('Anthropic rejects compound enum values and known regex restrictions', () => {
  assert.ok(
    codes({ enum: [{ value: 1 }] }, 'anthropic-json-output').includes(
      'anthropic.enum-primitive',
    ),
  );
  for (const pattern of ['(?=a)a', '(a)\\1', '\\bword\\b', '(?<=a)b']) {
    assert.ok(
      codes({ type: 'string', pattern }, 'anthropic-json-output').includes(
        'anthropic.pattern-feature',
      ),
    );
  }
  assert.deepEqual(
    lint({ type: 'string', pattern: '^[A-Za-z]+$' }, 'anthropic-json-output'),
    [],
  );
});

test('format support differs by provider and stays source-linked', () => {
  assert.deepEqual(
    lint(
      object({ value: { type: 'string', format: 'uri' } }),
      'anthropic-json-output',
    ),
    [],
  );
  assert.ok(
    codes(object({ value: { type: 'string', format: 'uri' } })).includes(
      'openai.undocumented-format',
    ),
  );
  assert.ok(
    codes(
      { type: 'string', format: 'regex' },
      'anthropic-json-output',
    ).includes('anthropic.unsupported-format'),
  );
});

test('OpenAI enforces aggregate enum counts and large-enum text limits', () => {
  assert.ok(
    codes(
      object({ value: { enum: Array.from({ length: 1001 }, (_, i) => i) } }),
    ).includes('openai.enum-limit'),
  );
  assert.ok(
    codes(
      object({
        value: {
          enum: Array.from({ length: 251 }, (_, i) => `${i}-${'x'.repeat(60)}`),
        },
      }),
    ).includes('openai.enum-text-limit'),
  );
});

test('OpenAI property and aggregate text limits include schemas in definitions', () => {
  const properties = Object.fromEntries(
    Array.from({ length: 5001 }, (_, i) => [`p${i}`, { type: 'string' }]),
  );
  assert.ok(codes(object(properties)).includes('openai.property-limit'));
  assert.ok(
    codes(object({ ['x'.repeat(120001)]: { type: 'string' } })).includes(
      'openai.text-limit',
    ),
  );
});

test('OpenAI nesting counts arrays and inline objects with the root at level one', () => {
  let value = { type: 'string' };
  for (let i = 0; i < 9; i++) value = { type: 'array', items: value };
  assert.ok(!codes(object({ value })).includes('openai.nesting-limit'));
  value = { type: 'array', items: value };
  assert.ok(codes(object({ value })).includes('openai.nesting-limit'));
});

test('OpenAI nesting follows an acyclic chain of references', () => {
  const schema = object({ value: { $ref: '#/$defs/node0' } });
  schema.$defs = {};
  for (let index = 0; index < 10; index++)
    schema.$defs[`node${index}`] = object({
      child:
        index === 9 ? { type: 'string' } : { $ref: `#/$defs/node${index + 1}` },
    });
  assert.ok(codes(schema).includes('openai.nesting-limit'));
});

test('composition and reference siblings do not add a second data nesting level', () => {
  let schema = object({ value: { type: 'string' } });
  for (let index = 0; index < 9; index++)
    schema = object({
      value: {
        ...schema,
        anyOf: [object({ alternative: { type: 'string' } })],
      },
    });
  assert.ok(!codes(schema).includes('openai.nesting-limit'));
  const referred = {
    ...object({ value: { type: 'string' } }),
    $ref: '#/$defs/same',
    $defs: { same: object({ other: { type: 'string' } }) },
  };
  assert.ok(!codes(referred).includes('openai.nesting-limit'));
});

test('Gemini non-string/non-numeric enums receive portability warnings, not asserted rejections', () => {
  const findings = lint({ enum: [true, false] }, 'gemini-json-output');
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'gemini.undocumented-enum' &&
        finding.severity === 'warning',
    ),
  );
  assert.deepEqual(errors({ enum: [true, false] }, 'gemini-json-output'), []);
});

test('Anthropic request limits catch schemas that alone exceed aggregate budgets', () => {
  assert.ok(
    codes(
      object(
        Object.fromEntries(
          Array.from({ length: 25 }, (_, index) => [
            `p${index}`,
            { type: 'string' },
          ]),
        ),
        [],
      ),
      'anthropic-json-output',
    ).includes('anthropic.optional-limit'),
  );
  assert.ok(
    codes(
      object(
        Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [
            `p${index}`,
            { type: ['string', 'null'] },
          ]),
        ),
      ),
      'anthropic-json-output',
    ).includes('anthropic.union-limit'),
  );
});

test('known keyword value shapes are checked before provider-specific interpretation', () => {
  for (const schema of [null, [], 'schema', 4])
    assert.ok(codes(schema).includes('schema.invalid-node'));
  for (const schema of [
    { type: 'made-up' },
    { type: [] },
    { type: ['string', 'string'] },
    { properties: [] },
    { required: ['x', 'x'] },
    { anyOf: [] },
    { items: 4 },
    { enum: 'x' },
    { minItems: -1 },
    { multipleOf: 0 },
  ])
    assert.ok(codes(schema).some((code) => code.startsWith('schema.')));
});

test('schema-bearing composition, dependency and tuple positions are traversed', () => {
  for (const schema of [
    { if: { type: 'invalid' } },
    { properties: { x: { type: 'invalid' } } },
    { dependentSchemas: { x: { type: 'invalid' } } },
    { dependencies: { x: { type: 'invalid' } } },
    { prefixItems: [{ type: 'invalid' }] },
    { items: [{ type: 'invalid' }] },
    { additionalProperties: { type: 'invalid' } },
  ])
    assert.ok(codes(schema).includes('schema.invalid-keyword'));
});

test('boolean schemas and legacy tuples warn without being mislabeled invalid JSON Schema', () => {
  assert.ok(
    codes(true, 'gemini-json-output').includes('heuristic.boolean-schema'),
  );
  assert.ok(
    !codes(false, 'gemini-json-output').includes('schema.invalid-node'),
  );
  assert.ok(
    codes(
      { type: 'array', items: [{ type: 'string' }] },
      'gemini-json-output',
    ).includes('gemini.tuple-items'),
  );
});

test('a property named additionalProperties still gets boolean-schema analysis', () => {
  const findings = lint(object({ additionalProperties: false }));
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'heuristic.boolean-schema' &&
        finding.path === '/properties/additionalProperties',
    ),
  );
});

test('supported definition containers do not produce false undocumented warnings', () => {
  const schema = object({ value: { $ref: '#/$defs/entry' } });
  schema.$defs = { entry: { type: 'string' } };
  assert.deepEqual(lint(schema, 'gemini-json-output'), []);
  const legacy = object({ value: { $ref: '#/definitions/entry' } });
  legacy.definitions = { entry: { type: 'string' } };
  assert.deepEqual(lint(legacy, 'anthropic-json-output'), []);
});

test('root anyOf is checked after a local reference is resolved', () => {
  const schema = {
    $ref: '#/$defs/entry',
    $defs: {
      entry: {
        ...object({ value: { type: 'string' } }),
        anyOf: [{ required: ['value'] }],
      },
    },
  };
  assert.ok(
    lint(schema).some(
      (finding) =>
        finding.code === 'openai.root-anyof' &&
        finding.path === '/$defs/entry/anyOf',
    ),
  );
});

test('root reference resolution preserves sibling constraints', () => {
  const schema = {
    $ref: '#/$defs/entry',
    anyOf: [{ type: 'object' }],
    $defs: { entry: object({ value: { type: 'string' } }) },
  };
  assert.ok(
    lint(schema).some(
      (finding) =>
        finding.code === 'openai.root-anyof' && finding.path === '/anyOf',
    ),
  );
  assert.ok(
    codes({
      $ref: '#/$defs/entry',
      type: 'string',
      $defs: schema.$defs,
    }).includes('openai.root-object'),
  );
});

test('reference-only root cycles produce an incomplete-analysis warning', () => {
  assert.ok(codes({ $ref: '#' }).includes('openai.unresolved-root-kind'));
  const aliases = {
    $ref: '#/$defs/a',
    $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } },
  };
  assert.ok(codes(aliases).includes('openai.unresolved-root-kind'));
});

test('Anthropic regex scanning distinguishes assertions from literals and classes', () => {
  for (const pattern of [
    String.raw`[(?=)]`,
    String.raw`[\b]`,
    String.raw`\\b`,
    String.raw`\(\?=`,
    String.raw`[\1]`,
  ]) {
    assert.ok(
      !codes({ type: 'string', pattern }, 'anthropic-json-output').includes(
        'anthropic.pattern-feature',
      ),
      pattern,
    );
  }
  assert.ok(
    codes(
      { type: 'string', pattern: String.raw`\\\b` },
      'anthropic-json-output',
    ).includes('anthropic.pattern-feature'),
  );
});

test('JavaScript cycles fail promptly while shared acyclic objects remain valid', () => {
  const cycle = object({});
  cycle.properties.self = cycle;
  assert.deepEqual(codes(cycle), ['input.cycle']);
  const shared = { type: 'string' };
  assert.deepEqual(lint(object({ first: shared, second: shared })), []);
});

test('invalid JavaScript values fail as input errors', () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    new Map(),
    [undefined],
    Array(2),
  ]) {
    assert.deepEqual(codes(value), ['input.not-json']);
  }
});

test('accessor properties are rejected without invoking user code', () => {
  let invoked = false;
  const schema = {
    get type() {
      invoked = true;
      return 'object';
    },
  };
  assert.deepEqual(codes(schema), ['input.accessor']);
  assert.equal(invoked, false);
});

test('input depth, count and text limits fail with explicit resource-limit diagnostics', () => {
  let deep = {};
  for (let i = 0; i < 130; i++) deep = { x: deep };
  for (const schema of [
    deep,
    { examples: Array(50001).fill(0) },
    { description: 'x'.repeat(2000001) },
  ]) {
    assert.deepEqual(codes(schema), ['input.limit']);
  }
});

test('results are deterministic across object insertion orders', () => {
  const left = {
    type: 'object',
    properties: { z: { type: 'string', minLength: 1 }, a: { type: 'object' } },
  };
  const right = {
    properties: { a: { type: 'object' }, z: { minLength: 1, type: 'string' } },
    type: 'object',
  };
  assert.deepEqual(lint(left), lint(right));
});

test('unknown provider profiles and stray option keys are rejected', () => {
  assert.throws(() => lintSchema(object(), { profile: 'all' }));
  assert.throws(() =>
    lintSchema(object(), { profile: 'openai-strict', mutate: true }),
  );
});
