import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/src/test/**/*.test.js',
  mocha: {
    ui: 'bdd',
    delay: false,
    require: ['./out/src/test/setup.js'],
  },
});
