import { z } from 'zod';
import { PROFILE_IDS } from '../dist/index.js';
import {
  assertEmitContract,
  checkEmitContract,
  defineEmitContract,
} from '../dist/emit.js';

const Summary = defineEmitContract({
  emit: z.strictObject({ title: z.string(), points: z.array(z.string()) }),
  strict: z.strictObject({
    title: z.string().max(20),
    points: z.array(z.string()).max(3),
  }),
  normalize: ({ title, points }) => {
    const text: string = title;
    const list: string[] = points;
    // @ts-expect-error Emitted titles retain their inferred string type.
    const invalid: number = title;
    void invalid;
    return { title: text.slice(0, 20), points: list.slice(0, 3) };
  },
});

checkEmitContract(Summary, {
  profiles: PROFILE_IDS,
  samples: [{ title: 'x', points: ['y'] }],
});
assertEmitContract(Summary, { profiles: PROFILE_IDS });
const output: { title: string; points: string[] } = Summary.parse({});
void output;
// @ts-expect-error Parse returns the strict output shape.
const wrong: number = Summary.parse({}).title;
void wrong;

defineEmitContract({
  emit: z.string(),
  strict: z.number(),
  // @ts-expect-error Normalize must return input accepted by the strict schema.
  normalize: (value) => value,
});

const TransformedStrict = defineEmitContract({
  emit: z.string(),
  strict: z.string().transform((value) => value.length),
  normalize: (value) => value.trim(),
});
const length: number = TransformedStrict.parse('example');
void length;
// @ts-expect-error Strict transforms affect the parser output type.
const text: string = TransformedStrict.parse('example');
void text;
