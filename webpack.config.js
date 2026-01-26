//@ts-check

'use strict';

const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const webpack = require('webpack');

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
  externals: {
    bufferutil: 'bufferutil',
    'utf-8-validate': 'utf-8-validate',
    fsevents: 'require("fsevents")',
    'split.js': 'Split',
    '@vscode/codicons': 'commonjs @vscode/codicons',
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
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
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@progressView': path.resolve(__dirname, 'src/progressView'),
      '@historyView': path.resolve(__dirname, 'src/historyView'),
      '@memoryView': path.resolve(__dirname, 'src/memoryView'),
      '@profileView': path.resolve(__dirname, 'src/profileView'),
      '@replacement': path.resolve(__dirname, 'src/replacement'),
      '@tools': path.resolve(__dirname, 'src/tools'),
      '@types': path.resolve(__dirname, 'src/types'),
      '@eventBus': path.resolve(__dirname, 'src/eventBus'),
      '@auth': path.resolve(__dirname, 'src/auth'),
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

/**
 * Webview configurations for Lit-based frontends.
 *
 * Lit-specific optimizations:
 * - DefinePlugin removes development-only code in production
 * - Tree shaking via optimization.usedExports (NOT sideEffects: false,
 *   which would break @customElement decorator registrations)
 * - Terser configured to preserve template literal structure
 */
const webviewConfigs = [
  'progressView',
  'memoryView',
  'historyView',
  'profileView',
  'webview',
].map((name) => ({
  name,
  target: 'web',
  mode: 'none',
  entry: `./src/${name}/frontend/index.ts`,
  output: {
    path: path.resolve(__dirname, `dist/${name}`),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: extensionConfig.resolve.alias,
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
        // Note: sideEffects must NOT be set to false here - @customElement
        // decorators have side effects (element registration). Tree shaking
        // is handled via optimization.usedExports instead.
      },
      {
        // CSS as string with ?inline suffix (for Lit css`` templates)
        // Returns raw CSS text for use with unsafeCSS()
        test: /\.css$/,
        resourceQuery: /inline/,
        type: 'asset/source',
      },
      {
        // Side-effect CSS imports - inject into document head at runtime
        // Used for: import 'katex/dist/katex.min.css', import './styles/index.css'
        test: /\.css$/,
        resourceQuery: { not: [/inline/] },
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              // Don't resolve url() - fonts are loaded via VS Code webview URI
              url: false,
            },
          },
        ],
      },
    ],
  },
  plugins: [
    // Enable Lit production mode (removes dev warnings and assertions)
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(
        process.env.NODE_ENV || 'production',
      ),
    }),
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
  optimization: {
    minimize: true,
    // Enable tree shaking
    usedExports: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          // Preserve template literal structure for Lit templates
          ecma: 2020,
          compress: {
            // Don't inline functions (can break Lit's tagged template caching)
            inline: 1,
            // Keep class names for better debugging
            keep_classnames: true,
          },
          mangle: {
            // Don't mangle property names (Lit uses property reflection)
            properties: false,
          },
          format: {
            // Preserve comments for @customElement decorators if needed
            comments: false,
          },
        },
      }),
    ],
  },
}));

module.exports = [extensionConfig, ...webviewConfigs];
