//@ts-check

'use strict';

const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context
  mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension
  output: {
    // the bundle is stored in the 'dist' folder
    path: path.resolve(__dirname, '..', 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    bufferutil: 'bufferutil',
    'utf-8-validate': 'utf-8-validate',
    fsevents: 'require("fsevents")',
    'split.js': 'Split',
    '@vscode/codicons': 'commonjs @vscode/codicons',
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files
    extensions: ['.ts', '.js'],
    alias: {
      '@': path.resolve(__dirname, '..', 'src'),
      '~': path.resolve(__dirname, '..', 'src'),
      '@shared': path.resolve(__dirname, '..', 'src/shared'),
      '@common': path.resolve(__dirname, '..', 'src/common'),
      '@webview': path.resolve(__dirname, '..', 'src/webview'),
      '@agent': path.resolve(__dirname, '..', 'src/agent'),
      '@frontend': path.resolve(__dirname, '..', 'src/frontend'),
      '@utils': path.resolve(__dirname, '..', 'src/utils'),
      '@logger': path.resolve(__dirname, '..', 'src/logger'),
      '@latex': path.resolve(__dirname, '..', 'src/latex'),
      '@commands': path.resolve(__dirname, '..', 'src/commands'),
      '@model': path.resolve(__dirname, '..', 'src/model'),
      '@housekeeping': path.resolve(__dirname, '..', 'src/housekeeping'),
      '@progressView': path.resolve(__dirname, '..', 'src/progressView'),
      '@historyView': path.resolve(__dirname, '..', 'src/historyView'),
      '@profileView': path.resolve(__dirname, '..', 'src/profileView'),
      '@replacement': path.resolve(__dirname, '..', 'src/replacement'),
      '@tools': path.resolve(__dirname, '..', 'src/tools'),
      '@types': path.resolve(__dirname, '..', 'src/types'),
      '@eventBus': path.resolve(__dirname, '..', 'src/eventBus'),
      '@auth': path.resolve(__dirname, '..', 'src/auth'),
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

module.exports = extensionConfig;
