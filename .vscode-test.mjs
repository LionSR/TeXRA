import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // Exclude progressView and toolUse tests due to webview .js module loading issues
  // These tests import production code that loads ESM .js files from src/ which
  // can't be resolved at runtime without a bundler
  exclude: [
    'out/test/progressView/**/*.test.js',
    'out/test/toolUse/**/*.test.js',
    'out/test/modelHandlers/ModelHandlerProgressView.test.js',
  ],
  mocha: {
    ui: 'bdd',
    delay: false,
    require: ['./out/test/setup.js'],
  },
});
