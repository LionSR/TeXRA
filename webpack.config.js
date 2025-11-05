//@ts-check

'use strict';

const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
  mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: [
    {
      bufferutil: 'bufferutil',
      'utf-8-validate': 'utf-8-validate',
      fsevents: 'require("fsevents")',
      'split.js': 'Split',
      '@vscode/codicons': 'commonjs @vscode/codicons',
      vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
      // modules added here also need to be added in the .vscodeignore file
      'zotero-api-client': 'commonjs zotero-api-client',
      '@babel/runtime-corejs3': 'commonjs @babel/runtime-corejs3',
      'core-js-pure': 'commonjs core-js-pure',
    },
    ({ request }, callback) => {
      if (typeof request !== 'string') {
        return callback();
      }

      if (
        request.startsWith('@babel/runtime-corejs3/') ||
        request.startsWith('core-js-pure/')
      ) {
        return callback(null, `commonjs ${request}`);
      }

      return callback();
    },
  ],
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '~': path.resolve(__dirname, 'src'),
      '@common': path.resolve(__dirname, 'src/common'),
      '@webview': path.resolve(__dirname, 'src/webview'),
      '@agent': path.resolve(__dirname, 'src/agent'),
      '@frontend': path.resolve(__dirname, 'src/frontend'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@logger': path.resolve(__dirname, 'src/logger'),
      '@latex': path.resolve(__dirname, 'src/latex'),
      '@commands': path.resolve(__dirname, 'src/commands'),
      '@model': path.resolve(__dirname, 'src/model'),
      '@housekeeping': path.resolve(__dirname, 'src/housekeeping'),
      '@progressView': path.resolve(__dirname, 'src/progressView'),
      '@historyView': path.resolve(__dirname, 'src/historyView'),
      '@replacement': path.resolve(__dirname, 'src/replacement'),
      '@tools': path.resolve(__dirname, 'src/tools'),
      '@types': path.resolve(__dirname, 'src/types'),
      '@eventBus': path.resolve(__dirname, 'src/eventBus'),
    },
    fallback: {
      fs: false,
      path: require.resolve('path-browserify'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
      {
        test: /\.node$/,
        use: 'node-loader',
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log', // enables logging required for problem matchers
  },
  optimization: {
    minimize: true,
    minimizer: [new TerserPlugin()],
  },
};
module.exports = [extensionConfig];
