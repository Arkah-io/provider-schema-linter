import type { Diagnostic, ProfileId } from './contracts.js';
import {
  diagnostic,
  isObject,
  pointer,
  recursiveReferences,
  type JsonObject,
  type SchemaGraph,
} from './schema-walker.js';

export const PROFILE_SOURCES: Record<ProfileId, string> = {
  'openai-strict':
    'https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas',
  'anthropic-json-output':
    'https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations',
  'gemini-json-output':
    'https://ai.google.dev/gemini-api/docs/structured-output?hl=en',
};

const METADATA = ['$schema', 'title', 'description'];
const ANNOTATIONS = new Set([
  '$comment',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const OPENAI_KEYWORDS = new Set([
  ...METADATA,
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  '$defs',
  '$ref',
  'enum',
  'const',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
]);
const OPENAI_UNSUPPORTED = new Set([
  'allOf',
  'not',
  'dependentRequired',
  'dependentSchemas',
  'if',
  'then',
  'else',
]);
const ANTHROPIC_KEYWORDS = new Set([
  ...METADATA,
  'default',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'allOf',
  '$defs',
  'definitions',
  '$ref',
  'enum',
  'const',
  'pattern',
  'format',
  'minItems',
]);
const ANTHROPIC_UNSUPPORTED = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
]);
const GEMINI_KEYWORDS = new Set([
  ...METADATA,
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'prefixItems',
  'anyOf',
  '$defs',
  '$ref',
  'enum',
  'format',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
]);
const OPENAI_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);
const ANTHROPIC_FORMATS = new Set([...OPENAI_FORMATS, 'uri']);

function objectNode(node: JsonObject): boolean {
  return (
    node.type === 'object' ||
    (Array.isArray(node.type) && node.type.includes('object')) ||
    'properties' in node
  );
}

function hasKind(node: JsonObject): boolean {
  return ['type', '$ref', 'enum', 'const', 'anyOf', 'oneOf', 'allOf'].some(
    (key) => key in node,
  );
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? [...value].length : 0;
}

function unsupportedAnthropicPattern(pattern: string): boolean {
  let characterClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const token = pattern[index];
    if (token === '\\') {
      let count = 1;
      while (pattern[index + count] === '\\') count++;
      if (count % 2 === 1) {
        const escaped = pattern[index + count];
        if (
          !characterClass &&
          escaped !== undefined &&
          ('bB123456789'.includes(escaped) ||
            (escaped === 'k' && pattern[index + count + 1] === '<'))
        )
          return true;
        index += count;
      } else index += count - 1;
      continue;
    }
    if (token === '[') characterClass = true;
    else if (token === ']') characterClass = false;
    else if (
      !characterClass &&
      token === '(' &&
      ['(?=', '(?!', '(?<=', '(?<!'].some((prefix) =>
        pattern.startsWith(prefix, index),
      )
    )
      return true;
  }
  return false;
}

/** A conservative lower bound: acyclic reference paths count; recursive backedges do not. */
function nestingDepth(graph: SchemaGraph): number {
  const depth = new Map<string, number>();
  const active = new Set<string>();
  const cyclic = recursiveReferences(graph);
  for (const start of graph.nodes) {
    if (depth.has(start.path)) continue;
    const stack: { path: string; finish: boolean }[] = [
      { path: start.path, finish: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const node = graph.byPath.get(frame.path);
      if (!node) continue;
      const edges = [...node.children];
      const ref = graph.references.get(frame.path);
      if (ref !== undefined && !cyclic.has(frame.path)) edges.push(ref);
      if (frame.finish) {
        active.delete(frame.path);
        const container =
          isObject(node.value) &&
          (node.value.type === 'array' ||
            objectNode(node.value) ||
            (Array.isArray(node.value.type) &&
              node.value.type.includes('array')));
        const local = Number(container);
        depth.set(
          frame.path,
          Math.max(
            local,
            ...edges.map(
              (edge) =>
                (depth.get(edge) ?? 0) +
                (node.nestedChildren.has(edge) ? local : 0),
            ),
          ),
        );
      } else if (!depth.has(frame.path) && !active.has(frame.path)) {
        active.add(frame.path);
        stack.push({ path: frame.path, finish: true });
        for (const edge of edges)
          if (!depth.has(edge) && !active.has(edge))
            stack.push({ path: edge, finish: false });
      }
    }
  }
  return Math.max(0, ...depth.values());
}

export function lintProfile(
  graph: SchemaGraph,
  profile: ProfileId,
): Diagnostic[] {
  const source = PROFILE_SOURCES[profile];
  const findings: Diagnostic[] = [];
  const emit = (
    code: string,
    path: string,
    message: string,
    severity: Diagnostic['severity'] = 'error',
  ) => findings.push(diagnostic(code, path, message, severity, source));
  let propertyCount = 0;
  let enumCount = 0;
  let nameCharacters = 0;
  let optionalProperties = 0;
  let unionProperties = 0;
  const recursive =
    profile === 'anthropic-json-output'
      ? recursiveReferences(graph)
      : new Set<string>();

  if (profile === 'openai-strict') {
    let root = graph.root;
    let path = '';
    const seen = new Set<string>();
    let objectRootFound = false;
    while (!seen.has(path)) {
      seen.add(path);
      if (isObject(root) && root.type === 'object') objectRootFound = true;
      if (
        !isObject(root) ||
        (root.type !== undefined && root.type !== 'object') ||
        (root.type === undefined && !('$ref' in root))
      )
        emit(
          'openai.root-object',
          path,
          'OpenAI strict output requires an object at the schema root.',
        );
      if (isObject(root) && 'anyOf' in root)
        emit(
          'openai.root-anyof',
          pointer(path, 'anyOf'),
          'OpenAI strict output does not allow anyOf at the root. Nested anyOf is supported.',
        );
      if (
        !isObject(root) ||
        typeof root.$ref !== 'string' ||
        !graph.references.has(path)
      )
        break;
      path = graph.references.get(path)!;
      root = graph.byPath.get(path)!.value;
      if (seen.has(path) && !objectRootFound)
        emit(
          'openai.unresolved-root-kind',
          path,
          'A reference-only cycle prevents this linter from establishing the required object root. Add an explicit object schema.',
          'warning',
        );
    }
  }

  for (const { value: node, path } of graph.nodes) {
    if (typeof node === 'boolean') {
      const objectClosure =
        path.endsWith('/additionalProperties') &&
        graph.byPath.has(path.slice(0, path.lastIndexOf('/')));
      if (objectClosure && (node === false || profile === 'gemini-json-output'))
        continue;
      emit(
        'heuristic.boolean-schema',
        path,
        'Boolean schemas are valid JSON Schema, but support at this schema location is not established by this profile.',
        'warning',
      );
      continue;
    }
    if (!hasKind(node))
      emit(
        'heuristic.unconstrained-schema',
        path,
        'This schema has no explicit type, enum, const, reference, or composition. Check for information lost during schema export.',
        'warning',
      );
    if (objectNode(node)) {
      const properties = isObject(node.properties)
        ? Object.keys(node.properties)
        : [];
      const required = new Set(
        Array.isArray(node.required)
          ? node.required.filter((item) => typeof item === 'string')
          : [],
      );
      propertyCount += properties.length;
      nameCharacters += properties.reduce(
        (total, name) => total + stringLength(name),
        0,
      );
      const missing = properties.filter((property) => !required.has(property));
      optionalProperties += missing.length;
      if (profile === 'openai-strict' || profile === 'anthropic-json-output') {
        const prefix = profile === 'openai-strict' ? 'openai' : 'anthropic';
        if (node.additionalProperties !== false)
          emit(
            `${prefix}.additional-properties`,
            pointer(path, 'additionalProperties'),
            'Every object must explicitly set additionalProperties to false in this output mode.',
          );
        if (profile === 'openai-strict' && missing.length > 0)
          emit(
            'openai.required-properties',
            pointer(path, 'required'),
            `Every property must be required. Missing: ${missing.map((name) => JSON.stringify(name)).join(', ')}. Use a required nullable field for optional values.`,
          );
      }
      if (
        node.additionalProperties === false &&
        properties.length === 0 &&
        !['patternProperties', '$ref', 'anyOf', 'allOf', 'oneOf'].some(
          (key) => key in node,
        )
      ) {
        emit(
          'heuristic.empty-object',
          path,
          'This closed object declares no properties. Confirm that an empty object is intentional and a record or catchall was not lost during export.',
          'warning',
        );
      }
      for (const property of properties) {
        const child = (node.properties as JsonObject)[property];
        if (
          isObject(child) &&
          ('anyOf' in child ||
            (Array.isArray(child.type) && child.type.length > 1))
        )
          unionProperties++;
      }
    }
    if (isObject(node.$defs))
      nameCharacters += Object.keys(node.$defs).reduce(
        (total, name) => total + stringLength(name),
        0,
      );
    if (Array.isArray(node.enum)) {
      enumCount += node.enum.length;
      const enumCharacters = node.enum.reduce<number>(
        (total, member) => total + stringLength(member),
        0,
      );
      nameCharacters += enumCharacters;
      if (
        profile === 'openai-strict' &&
        node.enum.length > 250 &&
        enumCharacters > 15_000
      )
        emit(
          'openai.enum-text-limit',
          pointer(path, 'enum'),
          'A string enum with more than 250 values must contain no more than 15,000 total string characters.',
        );
      if (
        profile === 'anthropic-json-output' &&
        node.enum.some(
          (member) => member !== null && typeof member === 'object',
        )
      )
        emit(
          'anthropic.enum-primitive',
          pointer(path, 'enum'),
          'Anthropic structured output supports primitive enum values only.',
        );
      if (
        profile === 'gemini-json-output' &&
        node.enum.some(
          (member) => typeof member !== 'string' && typeof member !== 'number',
        )
      )
        emit(
          'gemini.undocumented-enum',
          pointer(path, 'enum'),
          'The Gemini native output guide documents string and numeric enums. Support for other enum member types is not established by this profile.',
          'warning',
        );
    }
    nameCharacters += stringLength(node.const);
    if (
      profile === 'openai-strict' &&
      typeof node.format === 'string' &&
      !OPENAI_FORMATS.has(node.format)
    )
      emit(
        'openai.undocumented-format',
        pointer(path, 'format'),
        `Format ${JSON.stringify(node.format)} is outside the documented OpenAI strict format list. Verify its support or validate it after parsing.`,
        'warning',
      );
    if (profile === 'anthropic-json-output') {
      if (
        typeof node.format === 'string' &&
        !ANTHROPIC_FORMATS.has(node.format)
      )
        emit(
          'anthropic.unsupported-format',
          pointer(path, 'format'),
          `Format ${JSON.stringify(node.format)} is outside Anthropic's supported format list.`,
        );
      if (
        typeof node.minItems === 'number' &&
        node.minItems !== 0 &&
        node.minItems !== 1
      )
        emit(
          'anthropic.min-items',
          pointer(path, 'minItems'),
          'Anthropic structured output supports minItems only when its value is 0 or 1.',
        );
      if (typeof node.$ref === 'string' && !node.$ref.startsWith('#'))
        emit(
          'anthropic.external-reference',
          pointer(path, '$ref'),
          'Anthropic structured output supports internal references only.',
        );
      if (recursive.has(path))
        emit(
          'anthropic.recursive-reference',
          pointer(path, '$ref'),
          'Anthropic structured output does not support recursive references.',
        );
      if ('allOf' in node && '$ref' in node)
        emit(
          'anthropic.allof-reference',
          path,
          'Anthropic structured output does not support allOf combined with $ref at the same schema location.',
        );
      if (
        Array.isArray(node.allOf) &&
        node.allOf.some((member) => isObject(member) && '$ref' in member)
      )
        emit(
          'anthropic.allof-reference',
          pointer(path, 'allOf'),
          'Anthropic structured output does not support allOf containing $ref members.',
        );
      if (
        typeof node.pattern === 'string' &&
        unsupportedAnthropicPattern(node.pattern)
      )
        emit(
          'anthropic.pattern-feature',
          pointer(path, 'pattern'),
          'Anthropic patterns do not support backreferences, lookaround, or word-boundary assertions.',
        );
    }
    const supported =
      profile === 'openai-strict'
        ? OPENAI_KEYWORDS
        : profile === 'anthropic-json-output'
          ? ANTHROPIC_KEYWORDS
          : GEMINI_KEYWORDS;
    const unsupported =
      profile === 'openai-strict'
        ? OPENAI_UNSUPPORTED
        : profile === 'anthropic-json-output'
          ? ANTHROPIC_UNSUPPORTED
          : new Set<string>();
    const prefix =
      profile === 'openai-strict'
        ? 'openai'
        : profile === 'anthropic-json-output'
          ? 'anthropic'
          : 'gemini';
    for (const keyword of Object.keys(node)) {
      if (unsupported.has(keyword))
        emit(
          `${prefix}.unsupported-keyword`,
          pointer(path, keyword),
          `${keyword} is explicitly unsupported by this provider's structured-output documentation.`,
        );
      else if (!supported.has(keyword))
        emit(
          `${prefix}.undocumented-keyword`,
          pointer(path, keyword),
          ANNOTATIONS.has(keyword)
            ? `${keyword} is outside this profile's documented annotations. Transport acceptance and annotation handling are not guaranteed; verify them for your model and endpoint.`
            : `${keyword} is outside this profile's documented subset. Support or enforcement is not guaranteed; verify it for your model and endpoint.`,
          'warning',
        );
    }
    if (Array.isArray(node.items))
      emit(
        `${prefix}.tuple-items`,
        pointer(path, 'items'),
        'Legacy tuple-form items is outside this profile. Modern JSON Schema uses prefixItems, whose support also depends on the provider.',
        'warning',
      );
  }
  if (profile === 'openai-strict') {
    if (propertyCount > 5_000)
      emit(
        'openai.property-limit',
        '',
        `The schema declares ${propertyCount} object properties; OpenAI strict allows at most 5,000.`,
      );
    if (enumCount > 1_000)
      emit(
        'openai.enum-limit',
        '',
        `The schema declares ${enumCount} enum values; OpenAI strict allows at most 1,000 across the schema.`,
      );
    if (nameCharacters > 120_000)
      emit(
        'openai.text-limit',
        '',
        `Property names, definition names, enum strings, and const strings total ${nameCharacters} characters; OpenAI strict allows at most 120,000.`,
      );
    const nesting = nestingDepth(graph);
    if (nesting > 10)
      emit(
        'openai.nesting-limit',
        '',
        `A nonrecursive schema path has ${nesting} object/array levels; OpenAI strict allows at most 10 nesting levels. Recursive backreferences are not expanded.`,
      );
  }
  if (profile === 'anthropic-json-output') {
    if (optionalProperties > 24)
      emit(
        'anthropic.optional-limit',
        '',
        `This schema alone declares ${optionalProperties} optional properties; Anthropic permits at most 24 across JSON output and strict tools combined.`,
      );
    if (unionProperties > 16)
      emit(
        'anthropic.union-limit',
        '',
        `This schema alone declares ${unionProperties} properties with union types; Anthropic permits at most 16 across JSON output and strict tools combined.`,
      );
  }
  return findings;
}
