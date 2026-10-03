# Security policy

Report vulnerabilities through the repository's [private vulnerability form](https://github.com/Arkah-io/provider-schema-linter/security/advisories/new). Include a minimal synthetic JSON fixture, package version, and Node version. Remove credentials and customer data. Do not disclose vulnerability details in a public issue.

In scope: untrusted JSON that makes the raw linter or CLI fetch a URL, execute code, mutate input, hang, or bypass documented resource limits; terminal control sequences reaching CLI output unescaped; and unexpected crashes on bounded valid JSON input.

The Zod exporter and emit-contract helpers accept trusted application code. Zod can evaluate dynamic default suppliers during export, and `parse` executes the supplied normalizer and schema parsers. These helpers are not a sandbox for third-party JavaScript. The JSON CLI does not load JavaScript modules.

A wrong or outdated provider rule is a bug, not a vulnerability. Open a normal issue with the provider documentation link.

Supported versions: the latest patch of the `0.1.x` preview line. Security fixes are released there; no response-time guarantee is made.
