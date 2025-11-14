import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  mocha: {
    ui: 'bdd',
    delay: false,
    require: ['./out/test/setup.js'],
  },
});
