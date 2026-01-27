/**
 * Optimized highlight.js configuration for TeXRA.
 *
 * Imports only the languages relevant to a LaTeX research assistant,
 * reducing bundle size by ~85-90% compared to the full highlight.js package.
 *
 * Language categories:
 * - LaTeX ecosystem: latex (for .tex, .sty, .cls, .dtx, .tikz, .bst)
 * - Scientific computing: python, r, julia, matlab, mathematica, fortran
 * - Config/markup: json, yaml, xml, markdown
 * - Shell/build: bash, dockerfile, makefile
 * - Web (for snippets): javascript, typescript
 * - Fallback: plaintext
 *
 * @see https://highlightjs.org/
 */

// Core highlight.js (no languages bundled)
import hljs from 'highlight.js/lib/core';

// LaTeX ecosystem
import latex from 'highlight.js/lib/languages/latex';

// Scientific computing
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import julia from 'highlight.js/lib/languages/julia';
import matlab from 'highlight.js/lib/languages/matlab';
import mathematica from 'highlight.js/lib/languages/mathematica';
import fortran from 'highlight.js/lib/languages/fortran';

// Config and markup
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';

// Shell and build tools
import bash from 'highlight.js/lib/languages/bash';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import makefile from 'highlight.js/lib/languages/makefile';

// Web languages (for code snippets in research)
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';

// Fallback
import plaintext from 'highlight.js/lib/languages/plaintext';

// Register all languages
hljs.registerLanguage('latex', latex);
hljs.registerLanguage('tex', latex); // Alias for .tex files
hljs.registerLanguage('bibtex', latex); // BibTeX is similar enough to LaTeX

hljs.registerLanguage('python', python);
hljs.registerLanguage('r', r);
hljs.registerLanguage('julia', julia);
hljs.registerLanguage('matlab', matlab);
hljs.registerLanguage('mathematica', mathematica);
hljs.registerLanguage('fortran', fortran);

hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('markdown', markdown);

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash); // Common alias
hljs.registerLanguage('sh', bash); // Another common alias
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('makefile', makefile);

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript); // Common alias
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript); // Common alias

hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext); // Common alias

/**
 * Pre-configured highlight.js instance with TeXRA-relevant languages.
 * Use this instead of importing from 'highlight.js' directly.
 */
export default hljs;
