// Test setup file for Mocha
// This file is loaded before all tests to configure the test environment

// Standard library imports
import * as path from 'path';

// Third-party imports
import { register } from 'tsconfig-paths';

// Register tsconfig paths with correct base URL for compiled files
// The compiled output is in 'out/', but .js source files remain in 'src/'
// so we need to check both locations
const outDir = path.resolve(__dirname, '..');
const srcDir = path.resolve(__dirname, '..', '..', 'src');

register({
  baseUrl: outDir,
  paths: {
    '@/*': ['*', path.join(srcDir, '*')],
    '~/*': ['*', path.join(srcDir, '*')],
    '@common/*': ['common/*', path.join(srcDir, 'common/*')],
    '@webview/*': ['webview/*', path.join(srcDir, 'webview/*')],
    '@agent/*': ['agent/*', path.join(srcDir, 'agent/*')],
    '@frontend/*': ['frontend/*', path.join(srcDir, 'frontend/*')],
    '@utils/*': ['utils/*', path.join(srcDir, 'utils/*')],
    '@logger/*': ['logger/*', path.join(srcDir, 'logger/*')],
    '@latex': ['latex', path.join(srcDir, 'latex')],
    '@latex/*': ['latex/*', path.join(srcDir, 'latex/*')],
    '@commands/*': ['commands/*', path.join(srcDir, 'commands/*')],
    '@model': ['model', path.join(srcDir, 'model')],
    '@model/*': ['model/*', path.join(srcDir, 'model/*')],
    '@housekeeping': ['housekeeping', path.join(srcDir, 'housekeeping')],
    '@housekeeping/*': ['housekeeping/*', path.join(srcDir, 'housekeeping/*')],
    '@progressView/*': ['progressView/*', path.join(srcDir, 'progressView/*')],
    '@settingsView/*': ['settingsView/*', path.join(srcDir, 'settingsView/*')],
    '@replacement/*': ['replacement/*', path.join(srcDir, 'replacement/*')],
    '@tools/*': ['tools/*', path.join(srcDir, 'tools/*')],
    '@types/*': ['types/*', path.join(srcDir, 'types/*')],
    '@eventBus/*': ['eventBus/*', path.join(srcDir, 'eventBus/*')],
  },
});

// Set longer timeout for VS Code extension tests
if (typeof mocha !== 'undefined') {
  mocha.timeout(10000);
}

// Export empty object to make this a valid module
export {};
