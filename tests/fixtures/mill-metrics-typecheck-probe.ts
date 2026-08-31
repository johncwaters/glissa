// Deliberately wrong, and never compiled by npm run typecheck: tests/typecheck-gate.test.js asserts tsc
// REJECTS this file, which is what proves a cross-file require() of a CommonJS .ts module is typed
// rather than silently any. A CommonJS .ts module exports nothing to TypeScript, so the module surface
// is published as a global type and the require binding is annotated with it.
const { classifyPrompt }: MillMetricsCore = require('../../server/core/mill-metrics-core.ts');

classifyPrompt();
