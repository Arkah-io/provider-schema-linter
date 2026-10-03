import type { Diagnostic } from './contracts.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type SchemaNode = {
  value: JsonObject | boolean;
  path: string;
  children: string[];
  nestedChildren: Set<string>;
};
export type SchemaGraph = {
  root: JsonObject | boolean;
  nodes: SchemaNode[];
  byPath: Map<string, SchemaNode>;
  references: Map<string, string>;
};

export const JSON_SCHEMA_SOURCE =
  'https://json-schema.org/draft/2020-12/json-schema-core';
export const JSON_VALIDATION_SOURCE =
  'https://json-schema.org/draft/2020-12/json-schema-validation';
export const INPUT_LIMITS = Object.freeze({
  nodes: 50_000,
  depth: 128,
  characters: 2_000_000,
});

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

export function diagnostic(
  code: string,
  path: string,
  message: string,
  severity: Diagnostic['severity'] = 'error',
  source = JSON_SCHEMA_SOURCE,
): Diagnostic {
  return { code, severity, path, message, source };
}

/** Copy JSON data without invoking accessors; reject cycles and bounded-input violations. */
export function readJsonInput(input: unknown): {
  value?: JsonValue;
  diagnostics: Diagnostic[];
} {
  const active = new WeakSet<object>();
  let nodes = 0;
  let characters = 0;
  let failure: Diagnostic | undefined;
  const fail = (code: string, path: string, message: string): never => {
    failure = diagnostic(code, path, message);
    throw new Error('invalid-json-input');
  };
  const copy = (value: unknown, path: string, depth: number): JsonValue => {
    if (++nodes > INPUT_LIMITS.nodes || depth > INPUT_LIMITS.depth) {
      fail(
        'input.limit',
        path,
        `Input exceeds ${INPUT_LIMITS.nodes} values or ${INPUT_LIMITS.depth} levels. Split the schema before linting.`,
      );
    }
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > INPUT_LIMITS.characters)
        fail(
          'input.limit',
          path,
          `Input exceeds ${INPUT_LIMITS.characters} text characters.`,
        );
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null) {
      fail(
        'input.not-json',
        path,
        'Expected JSON data: null, boolean, finite number, string, array, or plain object.',
      );
    }
    const object = value as object;
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      fail(
        'input.not-json',
        path,
        'Expected a plain JSON object, not a class instance.',
      );
    }
    if (active.has(object))
      fail(
        'input.cycle',
        path,
        'The JavaScript input contains a cycle. Express schema recursion with a local $ref instead.',
      );
    active.add(object);
    const keys = Object.keys(object);
    if (keys.length > INPUT_LIMITS.nodes - nodes)
      fail('input.limit', path, `Input exceeds ${INPUT_LIMITS.nodes} values.`);
    const result: JsonValue[] | JsonObject = array
      ? []
      : (Object.create(null) as JsonObject);
    if (array) {
      const length = (object as unknown[]).length;
      if (length > INPUT_LIMITS.nodes - nodes)
        fail(
          'input.limit',
          path,
          `Input exceeds ${INPUT_LIMITS.nodes} values.`,
        );
      if (
        keys.length !== length ||
        keys.some((key, index) => key !== String(index))
      ) {
        fail(
          'input.not-json',
          path,
          'JSON arrays must be dense and have no extra enumerable properties.',
        );
      }
    }
    for (const key of keys.sort()) {
      characters += key.length;
      if (characters > INPUT_LIMITS.characters)
        fail(
          'input.limit',
          path,
          `Input exceeds ${INPUT_LIMITS.characters} text characters.`,
        );
      const property = Object.getOwnPropertyDescriptor(object, key);
      if (!property || !('value' in property))
        fail(
          'input.accessor',
          pointer(path, key),
          'Schema input must contain data properties; getters and setters are not evaluated.',
        );
      const child = copy(property!.value, pointer(path, key), depth + 1);
      Object.defineProperty(result, key, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(object);
    return result;
  };
  try {
    return { value: copy(input, '', 0), diagnostics: [] };
  } catch {
    return {
      diagnostics: [
        failure ??
          diagnostic(
            'input.not-json',
            '',
            'Input could not be inspected as JSON data.',
          ),
      ],
    };
  }
}

const MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const SINGLE_KEYWORDS = new Set([
  'additionalProperties',
  'additionalItems',
  'contains',
  'not',
  'propertyNames',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
]);
const LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const NONNEGATIVE_INTEGER_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains',
]);
const NUMBER_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);
const STRING_KEYWORDS = new Set([
  '$ref',
  '$schema',
  '$id',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  'title',
  'description',
  'pattern',
  'format',
  'contentEncoding',
  'contentMediaType',
]);
const TYPES = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'string',
  'integer',
]);

function uniqueStrings(value: JsonValue): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}

/** Visit schema-bearing locations only. Values in enum/default/examples remain literal data. */
export function walkSchema(
  root: JsonValue,
  diagnostics: Diagnostic[],
): SchemaGraph | undefined {
  if (!isObject(root) && typeof root !== 'boolean') {
    diagnostics.push(
      diagnostic(
        'schema.invalid-node',
        '',
        'A JSON Schema must be an object or boolean.',
      ),
    );
    return undefined;
  }
  const nodes: SchemaNode[] = [];
  const byPath = new Map<string, SchemaNode>();
  const references = new Map<string, string>();
  const visit = (value: JsonValue, path: string): void => {
    if (!isObject(value) && typeof value !== 'boolean') {
      diagnostics.push(
        diagnostic(
          'schema.invalid-node',
          path,
          'A schema-bearing location must contain an object or boolean.',
        ),
      );
      return;
    }
    const entry: SchemaNode = {
      value,
      path,
      children: [],
      nestedChildren: new Set(),
    };
    nodes.push(entry);
    byPath.set(path, entry);
    if (typeof value === 'boolean') return;
    const invalid = (key: string, expected: string) =>
      diagnostics.push(
        diagnostic(
          'schema.invalid-keyword',
          pointer(path, key),
          `${key} must be ${expected}.`,
        ),
      );
    const child = (
      next: JsonValue,
      nextPath: string,
      definition = false,
      nested = false,
    ) => {
      if (!definition) entry.children.push(nextPath);
      if (nested) entry.nestedChildren.add(nextPath);
      visit(next, nextPath);
    };
    for (const key of Object.keys(value).sort()) {
      const item = value[key]!;
      const itemPath = pointer(path, key);
      if (MAP_KEYWORDS.has(key)) {
        if (!isObject(item)) invalid(key, 'an object mapping names to schemas');
        else
          for (const name of Object.keys(item).sort())
            child(
              item[name]!,
              pointer(itemPath, name),
              key === '$defs' || key === 'definitions',
              key === 'properties' || key === 'patternProperties',
            );
      } else if (SINGLE_KEYWORDS.has(key)) {
        child(
          item,
          itemPath,
          false,
          [
            'additionalProperties',
            'additionalItems',
            'contains',
            'propertyNames',
            'unevaluatedProperties',
            'unevaluatedItems',
          ].includes(key),
        );
      } else if (
        LIST_KEYWORDS.has(key) ||
        (key === 'items' && Array.isArray(item))
      ) {
        if (!Array.isArray(item) || item.length === 0)
          invalid(key, 'a nonempty array of schemas');
        else
          item.forEach((member, index) =>
            child(
              member,
              pointer(itemPath, index),
              false,
              key === 'prefixItems' || key === 'items',
            ),
          );
      } else if (key === 'items') {
        child(item, itemPath, false, true);
      } else if (key === 'dependencies' || key === 'dependentRequired') {
        if (!isObject(item)) invalid(key, 'an object');
        else
          for (const name of Object.keys(item).sort()) {
            const dependency = item[name]!;
            if (Array.isArray(dependency)) {
              if (!uniqueStrings(dependency))
                diagnostics.push(
                  diagnostic(
                    'schema.invalid-keyword',
                    pointer(itemPath, name),
                    'A property dependency must be an array of unique strings.',
                  ),
                );
            } else if (key === 'dependencies')
              child(dependency, pointer(itemPath, name));
            else
              diagnostics.push(
                diagnostic(
                  'schema.invalid-keyword',
                  pointer(itemPath, name),
                  'A property dependency must be an array of unique strings.',
                ),
              );
          }
      } else if (key === 'type') {
        if (
          !(typeof item === 'string' && TYPES.has(item)) &&
          !(
            uniqueStrings(item) &&
            item.length > 0 &&
            item.every((type) => TYPES.has(type))
          )
        )
          invalid(
            key,
            'a JSON Schema type name or a nonempty array of unique type names',
          );
      } else if (key === 'required' && !uniqueStrings(item))
        invalid(key, 'an array of unique property names');
      else if (key === 'enum' && !Array.isArray(item)) invalid(key, 'an array');
      else if (STRING_KEYWORDS.has(key) && typeof item !== 'string')
        invalid(key, 'a string');
      else if (
        NONNEGATIVE_INTEGER_KEYWORDS.has(key) &&
        !(typeof item === 'number' && Number.isInteger(item) && item >= 0)
      )
        invalid(key, 'a nonnegative integer');
      else if (NUMBER_KEYWORDS.has(key) && typeof item !== 'number')
        invalid(key, 'a number (draft 6 and later)');
      else if (key === 'multipleOf' && !(typeof item === 'number' && item > 0))
        invalid(key, 'a positive number');
      else if (
        ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'].includes(key) &&
        typeof item !== 'boolean'
      )
        invalid(key, 'a boolean');
    }
  };
  visit(root, '');
  for (const { value, path } of nodes) {
    if (
      isObject(value) &&
      ('$dynamicRef' in value || '$recursiveRef' in value)
    ) {
      const keyword = '$dynamicRef' in value ? '$dynamicRef' : '$recursiveRef';
      diagnostics.push(
        diagnostic(
          'reference.dynamic',
          pointer(path, keyword),
          'Dynamic and recursive reference keywords are not resolved. Use local $ref JSON Pointers for complete reference analysis.',
          'warning',
        ),
      );
    }
    if (!isObject(value) || typeof value.$ref !== 'string') continue;
    const refPath = pointer(path, '$ref');
    const reference = value.$ref;
    let ancestor = path;
    let scopedResource = false;
    while (ancestor !== '') {
      const candidate = byPath.get(ancestor);
      if (
        candidate &&
        isObject(candidate.value) &&
        typeof candidate.value.$id === 'string'
      ) {
        scopedResource = true;
        break;
      }
      ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
    }
    if (scopedResource) {
      diagnostics.push(
        diagnostic(
          'reference.scoped-id',
          refPath,
          'References inside nested $id resources are not resolved by this linter. Bundle resource scopes into one root document.',
          'warning',
        ),
      );
      continue;
    }
    if (!reference.startsWith('#')) {
      diagnostics.push(
        diagnostic(
          'reference.external',
          refPath,
          'External references are not fetched or resolved. Bundle the schema with local JSON Pointer references.',
          'warning',
        ),
      );
      continue;
    }
    let fragment: string;
    try {
      fragment = decodeURIComponent(reference.slice(1));
    } catch {
      diagnostics.push(
        diagnostic(
          'reference.invalid-pointer',
          refPath,
          'Reference contains an invalid percent escape.',
        ),
      );
      continue;
    }
    if (fragment !== '' && !fragment.startsWith('/')) {
      diagnostics.push(
        diagnostic(
          'reference.anchor',
          refPath,
          'Named anchors are not resolved by this linter. Use a local JSON Pointer reference.',
          'warning',
        ),
      );
      continue;
    }
    if (/~(?:[^01]|$)/u.test(fragment)) {
      diagnostics.push(
        diagnostic(
          'reference.invalid-pointer',
          refPath,
          'JSON Pointer escapes must use ~0 for ~ and ~1 for /.',
        ),
      );
      continue;
    }
    const tokens =
      fragment === ''
        ? []
        : fragment
            .slice(1)
            .split('/')
            .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
    const targetPath = tokens.reduce(
      (target, token) => pointer(target, token),
      '',
    );
    const target = byPath.get(targetPath);
    if (!target) {
      diagnostics.push(
        diagnostic(
          'reference.unresolved',
          refPath,
          'Reference does not point to a recognized schema-bearing location in this document.',
        ),
      );
    } else references.set(path, targetPath);
  }
  return { root, nodes, byPath, references };
}

/** Report the references whose target reaches their source, without expanding a recursive schema. */
export function recursiveReferences(graph: SchemaGraph): Set<string> {
  // Iterative Kosaraju avoids recursion depth and quadratic per-reference searches.
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const edges = [...node.children];
    const ref = graph.references.get(node.path);
    if (ref !== undefined) edges.push(ref);
    adjacency.set(node.path, edges);
    for (const edge of edges) {
      const incoming = reverse.get(edge) ?? [];
      incoming.push(node.path);
      reverse.set(edge, incoming);
    }
  }
  const visited = new Set<string>();
  const order: string[] = [];
  for (const node of graph.nodes) {
    if (visited.has(node.path)) continue;
    const stack: { path: string; finish: boolean }[] = [
      { path: node.path, finish: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.finish) {
        order.push(frame.path);
        continue;
      }
      if (visited.has(frame.path)) continue;
      visited.add(frame.path);
      stack.push({ path: frame.path, finish: true });
      for (const child of adjacency.get(frame.path) ?? [])
        if (!visited.has(child)) stack.push({ path: child, finish: false });
    }
  }
  const components = new Map<string, number>();
  let component = 0;
  for (const path of order.reverse()) {
    if (components.has(path)) continue;
    const pending = [path];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (components.has(current)) continue;
      components.set(current, component);
      pending.push(...(reverse.get(current) ?? []));
    }
    component++;
  }
  const recursive = new Set<string>();
  for (const [source, target] of graph.references) {
    if (components.get(source) === components.get(target))
      recursive.add(source);
  }
  return recursive;
}
