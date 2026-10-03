import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'arkah-schema-consumer-'));
const packed = join(temp, 'packed');
const consumer = join(temp, 'consumer');
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
try {
  await mkdir(packed);
  await mkdir(consumer);
  run('pnpm', ['pack', '--pack-destination', packed], root);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'schema-consumer-smoke',
      private: true,
      type: 'module',
    }),
  );
  run(
    'pnpm',
    [
      'add',
      join(packed, `${manifest.name}-${manifest.version}.tgz`),
      'zod@4.6.5',
      '--ignore-scripts',
    ],
    consumer,
  );
  const schema = await readFile(
    join(root, 'examples/portable-report.schema.json'),
    'utf8',
  );
  await writeFile(join(consumer, 'schema.json'), schema);
  const report = JSON.parse(
    run(
      'pnpm',
      [
        'exec',
        'provider-schema-lint',
        '--profile',
        'openai-strict',
        '--json',
        'schema.json',
      ],
      consumer,
    ),
  );
  assert.deepEqual(report.diagnostics, []);
  await writeFile(
    join(consumer, 'smoke.ts'),
    `
import assert from 'node:assert/strict';
import { z } from 'zod';
import { lintSchema, lintResultSchema, type LintResult } from 'arkah-provider-schema-linter';
import { lintZodSchema } from 'arkah-provider-schema-linter/zod';
import { assertEmitContract, defineEmitContract } from 'arkah-provider-schema-linter/emit';
const result: LintResult = lintSchema(${schema}, { profile: 'openai-strict' });
assert.deepEqual(lintResultSchema.parse(result).diagnostics, []);
const exported = lintZodSchema(z.strictObject({ note: z.string().nullable() }), { profile: 'openai-strict' });
assert.equal(exported.jsonSchema?.type, 'object');
assert.deepEqual(exported.result.diagnostics, []);
const Title = defineEmitContract({
  emit: z.strictObject({ title: z.string() }),
  strict: z.strictObject({ title: z.string().max(5) }),
  normalize: ({ title }) => ({ title: title.slice(0, 5) }),
});
const parsed: { title: string } = Title.parse({ title: 'longer than five' });
assert.equal(parsed.title, 'longe');
assertEmitContract(Title, { profiles: ['openai-strict', 'anthropic-json-output'] });
console.log('Clean consumer: ESM API, Zod and emit subpaths, declarations and installed CLI passed.');
`,
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        types: [],
        outDir: 'out',
      },
      include: ['smoke.ts'],
    }),
  );
  // Give the fixture Node declarations explicitly; they are not a runtime dependency.
  run(
    'pnpm',
    ['add', '-D', '@types/node@22.20.5', '--ignore-scripts'],
    consumer,
  );
  const config = JSON.parse(
    await readFile(join(consumer, 'tsconfig.json'), 'utf8'),
  );
  config.compilerOptions.types = ['node'];
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify(config));
  run(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(consumer, 'tsconfig.json'),
    ],
    consumer,
  );
  process.stdout.write(run(process.execPath, ['out/smoke.js'], consumer));
  for (const relative of [
    'README.md',
    'SECURITY.md',
    'LICENSE',
    'docs/provider-profiles.md',
    'docs/loose-emit.md',
    'examples/demo.mjs',
  ]) {
    assert.ok(
      (
        await readFile(
          join(consumer, 'node_modules/arkah-provider-schema-linter', relative),
        )
      ).length > 0,
    );
  }
  await rm(temp, { recursive: true });
} catch (error) {
  console.error(`Package smoke failed. Fixture retained at ${temp}`);
  if (error && typeof error === 'object' && 'stdout' in error)
    console.error(String(error.stdout));
  if (error && typeof error === 'object' && 'stderr' in error)
    console.error(String(error.stderr));
  throw error;
}
