'use strict';

const fs = require('fs');
const path = require('path');

/**
 * CSS @import regex - handles all valid @import formats:
 * - @import 'path';
 * - @import "path";
 * - @import url('path');
 * - @import url("path");
 * - @import url(path);  (no quotes)
 * - @import 'path' media-query;
 *
 * Pattern breakdown:
 * @import\s+           - @import followed by whitespace
 * (?:url\(\s*)?        - optional url( with optional space
 * (['"]?)              - optional opening quote (group 1)
 * ([^'"\s)]+)          - the path (group 2)
 * \1                   - matching closing quote
 * (?:\s*\))?           - optional closing ) with optional space
 * [^;]*                - anything before semicolon (media query)
 * ;                    - semicolon
 */
const IMPORT_REGEX =
  /@import\s+(?:url\(\s*)?(['"]?)([^'"\s)]+)\1(?:\s*\))?[^;]*;/g;

function inlineCss(filePath, loaderContext, visited) {
  const absolutePath = path.resolve(filePath);
  if (visited.has(absolutePath)) {
    return '';
  }
  visited.add(absolutePath);

  let css = fs.readFileSync(absolutePath, 'utf8');
  const baseDir = path.dirname(absolutePath);

  css = css.replace(IMPORT_REGEX, (match, _quote, importPath) => {
    if (
      importPath.startsWith('http://') ||
      importPath.startsWith('https://') ||
      importPath.startsWith('data:')
    ) {
      return match;
    }

    const resolvedPath = path.resolve(baseDir, importPath);
    loaderContext.addDependency(resolvedPath);
    return inlineCss(resolvedPath, loaderContext, visited);
  });

  return css;
}

module.exports = function inlineCssLoader(_source) {
  if (this.cacheable) {
    this.cacheable();
  }

  const callback = this.async();

  try {
    const css = inlineCss(this.resourcePath, this, new Set());
    const payload = JSON.stringify(css);
    const code =
      `const css = ${payload};\n` +
      "const style = document.createElement('style');\n" +
      'style.textContent = css;\n' +
      'document.head.appendChild(style);\n' +
      'export default css;\n';
    callback(null, code);
  } catch (error) {
    callback(error);
  }
};
