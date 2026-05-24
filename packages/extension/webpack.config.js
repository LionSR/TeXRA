//@ts-check

'use strict';

const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const webpack = require('webpack');

const packageSrc = path.resolve(__dirname, 'src');
const rootSrc = path.resolve(__dirname, '..', '..', 'src');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/**
 * Externals configuration for webview bundles.
 *
 * Maps imports to the global WebviewCommons UMD library, reducing bundle size
 * by sharing zod, lit, and @shared/* modules across all webviews.
 *
 * @type {import('webpack').ExternalsPlugin['externals']}
 */
const webviewExternals = {
  // Third-party: Zod
  zod: 'WebviewCommons',

  // Third-party: Lit core
  lit: 'WebviewCommons',
  'lit/decorators.js': 'WebviewCommons',
  'lit/directives/unsafe-html.js': 'WebviewCommons',
  'lit/directives/class-map.js': 'WebviewCommons',
  'lit/directives/style-map.js': 'WebviewCommons',
  'lit/directives/if-defined.js': 'WebviewCommons',
  'lit/directives/repeat.js': 'WebviewCommons',
  'lit/directives/guard.js': 'WebviewCommons',
  'lit/directives/cache.js': 'WebviewCommons',
  'lit/directives/keyed.js': 'WebviewCommons',
  'lit/directives/when.js': 'WebviewCommons',
  'lit/directives/choose.js': 'WebviewCommons',
  'lit/directives/map.js': 'WebviewCommons',
  'lit/directives/join.js': 'WebviewCommons',
  'lit/directives/range.js': 'WebviewCommons',
  'lit/directives/live.js': 'WebviewCommons',
  'lit/directives/ref.js': 'WebviewCommons',

  // Third-party: @lit/context
  '@lit/context': 'WebviewCommons',

  // Shared modules
  '@shared/BaseWebviewApp': 'WebviewCommons',
  '@shared/hostBridge': 'WebviewCommons',
  '@shared/schemas': 'WebviewCommons',
  '@shared/schemas/index': 'WebviewCommons',
  '@shared/schemas/commonViewMessages': 'WebviewCommons',
  '@shared/schemas/historyViewMessages': 'WebviewCommons',
  '@shared/schemas/memoryViewMessages': 'WebviewCommons',
  '@shared/schemas/profileViewMessages': 'WebviewCommons',
  '@shared/schemas/settingsViewMessages': 'WebviewCommons',
  '@shared/schemas/mainView': 'WebviewCommons',
  '@shared/schemas/progressView': 'WebviewCommons',
  '@shared/schemas/stream': 'WebviewCommons',
  '@shared/schemas/streamState': 'WebviewCommons',
  '@shared/schemas/output': 'WebviewCommons',
  '@shared/schemas/log': 'WebviewCommons',
  '@shared/schemas/taskGroup': 'WebviewCommons',
  '@shared/schemas/todo': 'WebviewCommons',
  '@shared/schemas/usage': 'WebviewCommons',
  '@shared/schemas/errors': 'WebviewCommons',
  '@shared/schemas/identifiers': 'WebviewCommons',
  '@shared/schemas/agent': 'WebviewCommons',
  '@shared/schemas/fileFields': 'WebviewCommons',
  '@shared/schemas/toolConfig': 'WebviewCommons',
  '@shared/schemas/storage': 'WebviewCommons',
  '@shared/schemas/prompts': 'WebviewCommons',
  '@shared/schemas/diffResult': 'WebviewCommons',
  '@shared/schemas/proposalFields': 'WebviewCommons',
  '@shared/schemas/contextManagement': 'WebviewCommons',
  '@shared/styles': 'WebviewCommons',
  '@shared/styles/index': 'WebviewCommons',
  '@shared/styles/commonViewStyles': 'WebviewCommons',
  '@shared/styles/litStyles': 'WebviewCommons',
  '@shared/styles/selectStyles': 'WebviewCommons',
  '@shared/styles/statusIndicatorStyles': 'WebviewCommons',
  '@shared/styles/permissionCardStyles': 'WebviewCommons',
  '@shared/styles/requestPanelStyles': 'WebviewCommons',
  '@shared/styles/badgeStyles': 'WebviewCommons',
  '@shared/state': 'WebviewCommons',
  '@shared/state/index': 'WebviewCommons',
  '@shared/state/PersistedState': 'WebviewCommons',
  '@shared/state/ToggleStateStore': 'WebviewCommons',
  '@shared/handlers/commonMessageHandlers': 'WebviewCommons',
  '@shared/contexts/themeContext': 'WebviewCommons',
  '@shared/controllers': 'WebviewCommons',
  '@shared/controllers/index': 'WebviewCommons',
  '@shared/controllers/CopyButtonController': 'WebviewCommons',
  '@shared/controllers/RecordingButtonController': 'WebviewCommons',
  '@shared/controllers/SortableController': 'WebviewCommons',
  '@shared/utils/events': 'WebviewCommons',
  '@shared/utils/uiConstants': 'WebviewCommons',
  '@shared/utils/path': 'WebviewCommons',
  '@shared/utils/string': 'WebviewCommons',
  '@shared/utils/clipboard': 'WebviewCommons',
  '@shared/utils/dispatcher': 'WebviewCommons',
  '@shared/utils/dom': 'WebviewCommons',
  '@shared/utils/icons': 'WebviewCommons',
  '@shared/utils/selectTemplates': 'WebviewCommons',
  '@shared/utils/textarea': 'WebviewCommons',
  '@shared/streams/streamSort': 'WebviewCommons',
  '@shared/streams/runSelection': 'WebviewCommons',
  '@shared/files/pastedImageConstants': 'WebviewCommons',
  '@shared/highlighting/hljs': 'WebviewCommons',
  '@shared/components': 'WebviewCommons',
  '@shared/components/index': 'WebviewCommons',
};

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
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    '@openai/codex-sdk': 'commonjs @openai/codex-sdk', // ESM-only; use esbuild builds which bundle it
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js'],
    alias: {
      '@': packageSrc,
      '~': packageSrc,
      '@common': path.resolve(rootSrc, 'common'),
      '@webview': path.resolve(packageSrc, 'webview'),
      '@agent': path.resolve(rootSrc, 'agent'),
      '@frontend': path.resolve(packageSrc, 'frontend'),
      '@hosts': path.resolve(rootSrc, 'hosts'),
      '@utils': path.resolve(rootSrc, 'utils'),
      '@logger': path.resolve(rootSrc, 'logger'),
      '@skills': path.resolve(rootSrc, 'skills'),
      '@latex': path.resolve(rootSrc, 'latex'),
      '@commands': path.resolve(packageSrc, 'commands'),
      '@resources': path.resolve(__dirname, 'resources'),
      '@controllers': path.resolve(rootSrc, 'controllers'),
      '@model': path.resolve(rootSrc, 'model'),
      '@housekeeping': path.resolve(rootSrc, 'housekeeping'),
      '@shared': path.resolve(rootSrc, 'shared'),
      '@progressView': path.resolve(packageSrc, 'progressView'),
      '@settingsView': path.resolve(packageSrc, 'settingsView'),
      '@replacement': path.resolve(rootSrc, 'replacement'),
      '@tools': path.resolve(rootSrc, 'tools'),
      '@types': path.resolve(rootSrc, 'types'),
      '@eventBus': path.resolve(rootSrc, 'eventBus'),
      '@auth': path.resolve(rootSrc, 'auth'),
      '@platform': path.resolve(rootSrc, 'platform'),
      '@telemetry': path.resolve(rootSrc, 'telemetry'),
      '@transcript': path.resolve(rootSrc, 'transcript'),
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
            options: {
              transpileOnly: true, // Skip type checking for faster builds
            },
          },
        ],
      },
      {
        test: /\.node$/,
        use: 'node-loader',
      },
      {
        test: /\.tex$/,
        type: 'asset/source',
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log', // enables logging required for problem matchers
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          // sdkErrorUtils relies on SDK error class/prototype names after
          // bundling; keep webpack packaging aligned with the esbuild path.
          keep_classnames: true,
          keep_fnames: true,
          mangle: {
            keep_classnames: true,
            keep_fnames: true,
          },
        },
      }),
    ],
  },
};

/**
 * Commons bundle configuration.
 *
 * Builds shared dependencies (zod, lit, @shared/*) as a UMD library
 * that is loaded once by all webviews. Individual webview bundles
 * reference this via externals, eliminating duplication.
 *
 * @type WebpackConfig
 */
const commonsConfig = {
  name: 'commons',
  target: 'web',
  mode: 'none',
  entry: path.resolve(rootSrc, 'shared/commons/index.ts'),
  output: {
    path: path.resolve(__dirname, 'dist/shared'),
    filename: 'commons.js',
    library: {
      name: 'WebviewCommons',
      type: 'umd',
      export: undefined, // Export all named exports
    },
    globalObject: 'globalThis',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: extensionConfig.resolve.alias,
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
            options: {
              transpileOnly: true, // Skip type checking for faster builds
            },
          },
        ],
      },
      {
        // CSS as string with ?inline suffix (for Lit css`` templates)
        test: /\.css$/,
        resourceQuery: /inline/,
        type: 'asset/source',
      },
      {
        // Side-effect CSS imports
        test: /\.css$/,
        resourceQuery: { not: [/inline/] },
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
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
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          ecma: 2020,
          compress: {
            inline: 1,
            keep_classnames: true,
          },
          mangle: {
            properties: false,
          },
          format: {
            comments: false,
          },
        },
      }),
    ],
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
 * - Externals reference WebviewCommons for shared dependencies
 */
const webviewConfigs = ['progressView', 'settingsView', 'webview'].map(
  (name) => ({
    name,
    target: 'web',
    mode: 'none',
    entry: `./src/${name}/frontend/index.ts`,
    output: {
      path: path.resolve(__dirname, `dist/${name}`),
      filename: 'bundle.js',
    },
    externals: webviewExternals,
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
              options: {
                transpileOnly: true, // Skip type checking for faster builds
              },
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
          use: ['style-loader', 'css-loader'],
        },
        {
          // Font files - emit to same folder as bundle
          test: /\.(woff|woff2|ttf|eot)$/,
          type: 'asset/resource',
          generator: {
            filename: '[name][ext]',
          },
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
  }),
);

module.exports = [extensionConfig, commonsConfig, ...webviewConfigs];
