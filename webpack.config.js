//@ts-check

/**
 * Legacy webpack.config.js - redirects to the new config location.
 *
 * This file maintains backward compatibility for tools that expect
 * webpack.config.js in the project root.
 *
 * For the actual webpack configurations, see:
 * - webpack/extension.config.js - VS Code extension host bundle
 * - webpack/webview.config.js - Webview browser bundles
 */

'use strict';

module.exports = require('./webpack/extension.config.js');
