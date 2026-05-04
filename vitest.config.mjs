import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

import { aliases, rootDir } from './scripts/aliases.mjs';

export default defineConfig({
  plugins: [texTemplatePlugin()],
  resolve: {
    alias: {
      ...aliases,
      electron: `${rootDir}/src/test-kernel/desktop/electronTestStub.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['src/test-kernel/**/*.vitest.{ts,mts}'],
    passWithNoTests: false,
  },
});

function texTemplatePlugin() {
  return {
    name: 'tex-template-loader',
    transform(_source, id) {
      if (!id.endsWith('.tex')) return undefined;

      const contents = readFileSync(id, 'utf8');
      return {
        code: `export default ${JSON.stringify(contents)};`,
        map: null,
      };
    },
  };
}
