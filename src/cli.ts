#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { PROFILE_IDS, profileIdSchema } from './contracts.js';
import { compareDiagnostics, lintSchema } from './lint.js';
import { lintLooseEmit } from './emit.js';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const HELP = `Usage: provider-schema-lint --profile PROFILE [--loose-emit] [--json] [--warnings-as-errors] FILE

Lint the JSON Schema object sent to a provider. Use - for stdin.
Profiles: ${PROFILE_IDS.join(', ')}

  --json                Print the versioned LintResult as JSON
  --loose-emit          Also warn about bounds that belong in normalization
  --warnings-as-errors  Exit 1 when warnings are present
  --list-profiles       Print profile identifiers
  --help                Show this help

Exit status: 0 = checks passed; 1 = lint findings; 2 = usage or input error.
Input is limited to 10 MiB. This command makes no network or model calls.
`;

async function readInput(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    length += buffer.byteLength;
    if (length > MAX_INPUT_BYTES) {
      stream.destroy();
      throw new Error('Input exceeds the 10 MiB limit.');
    }
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.length === 1 && args[0] === '--list-profiles') {
    process.stdout.write(`${PROFILE_IDS.join('\n')}\n`);
    return 0;
  }
  let profile: string | undefined;
  let file: string | undefined;
  let json = false;
  let warningsAsErrors = false;
  let looseEmit = false;
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
    } else if (!positionalOnly && arg === '--profile') {
      if (profile !== undefined) throw new Error('Specify --profile once.');
      profile = args[++i];
      if (profile === undefined) throw new Error('--profile needs a value.');
    } else if (!positionalOnly && arg === '--json') {
      json = true;
    } else if (!positionalOnly && arg === '--loose-emit') {
      looseEmit = true;
    } else if (!positionalOnly && arg === '--warnings-as-errors') {
      warningsAsErrors = true;
    } else if (!positionalOnly && arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown option ${JSON.stringify(arg)}. Use --help.`);
    } else {
      if (file !== undefined)
        throw new Error('Provide exactly one JSON file or -.');
      file = arg;
    }
  }
  const parsedProfile = profileIdSchema.safeParse(profile);
  if (!parsedProfile.success) {
    throw new Error(`Choose --profile from: ${PROFILE_IDS.join(', ')}.`);
  }
  if (file === undefined)
    throw new Error('Provide a JSON file, or - for stdin.');
  let schema: unknown;
  const content = await readInput(
    file === '-' ? process.stdin : createReadStream(file),
  );
  try {
    schema = JSON.parse(content);
  } catch {
    throw new Error('Input must be valid JSON containing the schema itself.');
  }
  const result = lintSchema(schema, { profile: parsedProfile.data });
  if (looseEmit) {
    // Policy warnings join the provider report; input errors would duplicate lintSchema's.
    const known = new Set(result.diagnostics.map((d) => JSON.stringify(d)));
    result.diagnostics.push(
      ...lintLooseEmit(schema).filter((d) => !known.has(JSON.stringify(d))),
    );
    result.diagnostics.sort(compareDiagnostics);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${result.profile} · rules ${result.rulesetVersion}\n`,
    );
    for (const diagnostic of result.diagnostics) {
      // JSON-escape schema-authored names so terminal control bytes stay inert.
      process.stdout.write(
        `${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${JSON.stringify(diagnostic.path || '<root>')}\n  ${JSON.stringify(diagnostic.message)}\n  ${diagnostic.source}\n`,
      );
    }
    const errors = result.diagnostics.filter(
      (d) => d.severity === 'error',
    ).length;
    process.stdout.write(
      `${errors} error(s), ${result.diagnostics.length - errors} warning(s)\n`,
    );
  }
  return result.diagnostics.some(
    (d) => d.severity === 'error' || warningsAsErrors,
  )
    ? 1
    : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Unable to read input.';
  if (process.argv.slice(2).includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ error: { code: 'cli.input', message } })}\n`,
    );
  } else {
    process.stderr.write(`provider-schema-lint: ${JSON.stringify(message)}\n`);
  }
  process.exitCode = 2;
}
