// Runs this probe on its own, outside the product test tiers:
//   npx vitest run --config .agents/docs/evidence/2026-09-25-workflow-generator-protocol/vitest.config.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: { include: ['*.vitest.ts'], testTimeout: 10_000 },
});
