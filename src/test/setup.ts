// Test setup file for Mocha
// This file is loaded before all tests to configure the test environment

// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import { register } from 'tsconfig-paths';

// Register tsconfig paths with correct base URL for compiled files
// The compiled output is in 'out/src' for root sources; package sources emit
// under their workspace path.
// so we need to check both locations
const outDir = path.resolve(__dirname, '..');
const srcDir = path.resolve(__dirname, '..', '..', 'src');
const extensionOutDir = path.resolve(
  __dirname,
  '..',
  '..',
  'packages',
  'extension',
  'src',
);
const extensionSrcDir = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'extension',
  'src',
);

// Only stub 'vscode' when the real module is not available.
// Probing with require.resolve() works correctly in all environments:
// the real vscode module is available inside the VS Code extension host
// (vscode-test runner), but not in plain Node.js / standalone Mocha runs
// — regardless of whether VSCODE_PID happens to be set in the shell.
let vscodeMissing = false;
try {
  require.resolve('vscode');
} catch {
  vscodeMissing = true;
}
const extraPaths: Record<string, string[]> = vscodeMissing
  ? { vscode: [path.join(outDir, 'test/support/vscode-mock')] }
  : {};

register({
  baseUrl: outDir,
  paths: {
    ...extraPaths,
    '@/*': [path.join(extensionOutDir, '*'), path.join(extensionSrcDir, '*')],
    '~/*': [path.join(extensionOutDir, '*'), path.join(extensionSrcDir, '*')],
    '@common/*': ['common/*', path.join(srcDir, 'common/*')],
    '@webview/*': [
      path.join(extensionOutDir, 'webview/*'),
      path.join(extensionSrcDir, 'webview/*'),
    ],
    '@agent/*': ['agent/*', path.join(srcDir, 'agent/*')],
    '@frontend/*': [
      path.join(extensionOutDir, 'frontend/*'),
      path.join(extensionSrcDir, 'frontend/*'),
    ],
    '@utils/*': ['utils/*', path.join(srcDir, 'utils/*')],
    '@logger/*': ['logger/*', path.join(srcDir, 'logger/*')],
    '@latex': ['latex', path.join(srcDir, 'latex')],
    '@latex/*': ['latex/*', path.join(srcDir, 'latex/*')],
    '@commands/*': [
      path.join(extensionOutDir, 'commands/*'),
      path.join(extensionSrcDir, 'commands/*'),
    ],
    '@model': ['model', path.join(srcDir, 'model')],
    '@model/*': ['model/*', path.join(srcDir, 'model/*')],
    '@housekeeping': ['housekeeping', path.join(srcDir, 'housekeeping')],
    '@housekeeping/*': ['housekeeping/*', path.join(srcDir, 'housekeeping/*')],
    '@progressView/*': [
      path.join(extensionOutDir, 'progressView/*'),
      path.join(extensionSrcDir, 'progressView/*'),
    ],
    '@settingsView/*': [
      path.join(extensionOutDir, 'settingsView/*'),
      path.join(extensionSrcDir, 'settingsView/*'),
    ],
    '@replacement/*': ['replacement/*', path.join(srcDir, 'replacement/*')],
    '@tools/*': ['tools/*', path.join(srcDir, 'tools/*')],
    '@types/*': ['types/*', path.join(srcDir, 'types/*')],
    '@eventBus/*': ['eventBus/*', path.join(srcDir, 'eventBus/*')],
    '@shared/*': ['shared/*', path.join(srcDir, 'shared/*')],
    '@auth/*': ['auth/*', path.join(srcDir, 'auth/*')],
    '@platform': ['platform', path.join(srcDir, 'platform')],
    '@platform/*': ['platform/*', path.join(srcDir, 'platform/*')],
  },
});

require.extensions['.tex'] = (module, filename) => {
  module.exports = fs.readFileSync(filename, 'utf8');
};

// Set longer timeout for VS Code extension tests
if (typeof mocha !== 'undefined') {
  mocha.timeout(10000);
}

// Export empty object to make this a valid module
export {};
