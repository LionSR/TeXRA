import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { defineConfig } from 'vitest/config';

import { aliases, rootDir } from './scripts/aliases.mjs';

const require = createRequire(import.meta.url);
const QUICKJS_WASM_ID = '@jitl/quickjs-wasmfile-release-sync/wasm';
const QUICKJS_WASM_VIRTUAL_ID = '\0texra-quickjs-wasm';
const quickJsWasmPath = require.resolve(QUICKJS_WASM_ID);

export default defineConfig({
  plugins: [texTemplatePlugin(), quickJsWasmPlugin()],
  resolve: {
    alias: {
      ...aliases,
      electron: `${rootDir}/src/test-kernel/desktop/electronTestStub.ts`,
      // Suites exercising VS Code-coupled modules run against this minimal
      // stub; inside the real extension host the genuine module wins.
      vscode: `${rootDir}/src/test-kernel/support/vscode-mock.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['src/test-kernel/**/*.vitest.ts'],
    passWithNoTests: false,
    setupFiles: ['src/test-kernel/support/setupFakePlatform.ts'],
    testTimeout: 10000,
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

function quickJsWasmPlugin() {
  return {
    name: 'quickjs-wasm-loader',
    enforce: 'pre',
    resolveId(source) {
      if (source === QUICKJS_WASM_ID) return QUICKJS_WASM_VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id !== QUICKJS_WASM_VIRTUAL_ID) return undefined;

      const contents = readFileSync(quickJsWasmPath);
      return {
        code: `export default Uint8Array.from(Buffer.from(${JSON.stringify(contents.toString('base64'))}, 'base64'));`,
        map: null,
      };
    },
  };
}
