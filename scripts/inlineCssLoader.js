'use strict';

const fs = require('fs');
const path = require('path');

const IMPORT_REGEX = /@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g;

function inlineCss(filePath, loaderContext, visited) {
  const absolutePath = path.resolve(filePath);
  if (visited.has(absolutePath)) {
    return '';
  }
  visited.add(absolutePath);

  let css = fs.readFileSync(absolutePath, 'utf8');
  const baseDir = path.dirname(absolutePath);

  css = css.replace(IMPORT_REGEX, (match, importPath) => {
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
