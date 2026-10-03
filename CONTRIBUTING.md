# Contributing

Use Node.js 20+ and pnpm 9. Run `pnpm install --frozen-lockfile`, make the change, then run `pnpm verify`, `pnpm smoke:package`, and `pnpm pack`.

## Add a rule with evidence

1. Identify the provider **and API mode**. A legacy SDK schema converter does not define every endpoint's behavior.
2. Link a primary source. Use an error for a documented incompatibility; use a warning for uncertain enforcement or a heuristic. Keep those meanings distinct.
3. Add a minimal synthetic failing fixture and a nearby supported counterexample to `test/core.test.mjs`.
4. Preserve deterministic output and RFC 6901 paths. Do not walk example values as schemas, mutate input, fetch references, or execute user code.
5. Update the profile documentation and ruleset version when behavior changes. Describe the effect on existing CI results.

Do not add application prompts, customer data, private production schemas, or generation/critique code. Provider probes, if contributed, should be opt-in and separate from the offline test suite; this package currently makes no live API calls.

Provider rules need primary-source evidence. Loose-emit rules in `src/emit.ts` are application policy: keep them warnings, explain the repair a normalizer would make, and document them in `docs/loose-emit.md`.

The pure core lives in `src/lint.ts`, `src/schema-walker.ts`, and `src/profiles.ts`. Public contracts are Zod-derived in `src/contracts.ts`; the CLI and native Zod exporter sit at separate entry points. Keep new behavior narrow and give incomplete analysis an explicit finding.

Release maintainers should follow [the release guide](docs/releasing.md). Pull requests should explain observable behavior and finish with the Impact to User section in the repository template.
