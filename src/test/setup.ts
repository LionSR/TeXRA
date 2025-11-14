/**
 * Test setup - register tsconfig path aliases
 * This file must not have any side effects that depend on Mocha globals
 */

// Use require to avoid triggering any ES6 import side effects
// eslint-disable-next-line @typescript-eslint/no-require-imports, import/order
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsConfigPaths = require('tsconfig-paths');

// Register immediately - this must happen before any test files load
const projectRoot = path.resolve(__dirname, '../..');
const cleanup = tsConfigPaths.register({
  baseUrl: projectRoot,
  paths: {
    '@/*': ['out/*'],
    '~/*': ['out/*'],
    '@common/*': ['out/common/*'],
    '@webview/*': ['out/webview/*'],
    '@agent/*': ['out/agent/*'],
    '@frontend/*': ['out/frontend/*'],
    '@utils/*': ['out/utils/*'],
    '@logger/*': ['out/logger/*'],
    '@latex': ['out/latex'],
    '@latex/*': ['out/latex/*'],
    '@commands/*': ['out/commands/*'],
    '@model': ['out/model'],
    '@model/*': ['out/model/*'],
    '@housekeeping': ['out/housekeeping'],
    '@housekeeping/*': ['out/housekeeping/*'],
    '@progressView/*': ['out/progressView/*'],
    '@historyView/*': ['out/historyView/*'],
    '@replacement/*': ['out/replacement/*'],
    '@tools/*': ['out/tools/*'],
    '@types/*': ['out/types/*'],
    '@eventBus/*': ['out/eventBus/*'],
  },
});
