//@ts-check

'use strict';

const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const { WebpackManifestPlugin } = require('webpack-manifest-plugin');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/**
 * Webview webpack configuration
 * Bundles TypeScript code for browser environment (VS Code webviews)
 *
 * @param {Record<string, string>} env - Environment variables from webpack CLI
 * @param {Record<string, unknown>} argv - Command line arguments
 * @returns {WebpackConfig}
 */
module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  /** @type WebpackConfig */
  const webviewConfig = {
    target: 'web', // Webviews run in a browser-like context
    mode: isProduction ? 'production' : 'development',

    // Entry points for each webview
    // Add more entries as you convert webviews to TypeScript bundles
    entry: {
      // Example: uncomment when ready to migrate
      // mainView: './src/webview/client/index.ts',
      // progressView: './src/progressView/client/index.ts',
      // historyView: './src/historyView/client/index.ts',
    },

    output: {
      path: path.resolve(__dirname, '..', 'dist/webview'),
      filename: '[name].bundle.js',
      // For production, include content hash for cache busting
      ...(isProduction && { filename: '[name].[contenthash].bundle.js' }),
      clean: true, // Clean the output directory before emit
    },

    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      alias: {
        // Shared code accessible from both extension and webview
        '@shared': path.resolve(__dirname, '..', 'src/shared'),
        // Webview-specific utilities
        '@webview-client': path.resolve(__dirname, '..', 'src/webview/client'),
      },
    },

    module: {
      rules: [
        // TypeScript/TSX files
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: [
            {
              loader: 'ts-loader',
              options: {
                configFile: path.resolve(__dirname, '..', 'tsconfig.webview.json'),
              },
            },
          ],
        },
        // CSS files
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },

    plugins: [
      // Generate manifest.json for production builds
      // This allows the extension to know which hashed bundle to load
      new WebpackManifestPlugin({
        fileName: 'manifest.json',
        publicPath: '',
      }),
    ],

    devtool: isProduction ? 'hidden-source-map' : 'source-map',

    optimization: {
      minimize: isProduction,
      minimizer: [new TerserPlugin()],
      // Split chunks for better caching
      ...(isProduction && {
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            // Separate vendor code (node_modules)
            vendor: {
              test: /[\\/]node_modules[\\/]/,
              name: 'vendors',
              chunks: 'all',
            },
            // Shared code between webviews
            shared: {
              test: /[\\/]src[\\/]shared[\\/]/,
              name: 'shared',
              chunks: 'all',
              minSize: 0,
            },
          },
        },
      }),
    },

    // Development server for HMR (Hot Module Replacement)
    devServer: {
      static: {
        directory: path.resolve(__dirname, '..', 'dist/webview'),
      },
      port: 9000,
      hot: true,
      compress: true,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    },

    // Performance hints
    performance: {
      hints: isProduction ? 'warning' : false,
      maxAssetSize: 512000, // 500 KB
      maxEntrypointSize: 512000,
    },
  };

  return webviewConfig;
};
