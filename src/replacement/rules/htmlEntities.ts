// Local imports - replacement
import { ReplacementCategory } from '../types';

export const HTML_ENTITY_REPLACEMENTS: ReplacementCategory = {
  name: 'html_entities',
  description: 'Converts common HTML entities into LaTeX-safe equivalents',
  isRegex: false,
  patterns: {
    // Angle brackets often appear when XML tags are HTML-escaped
    '&lt;': '<',
    '&gt;': '>',

    // Ampersands should be escaped in LaTeX to avoid alignment issues
    '&amp;': '\\&',

    // Quotes and spacing
    '&quot;': '"',
    '&apos;': '\'',
    '&nbsp;': '~',

    // Basic comparison operators frequently appear in HTML-escaped math
    '&le;': '\\leq',
    '&ge;': '\\geq',
    '&ne;': '\\neq',

    // Math operators and punctuation
    '&plusmn;': '\\pm',
    '&minus;': '-',
    '&times;': '\\times',
    '&divide;': '\\div',
    '&middot;': '\\cdot',
    '&sdot;': '\\cdot',
    '&hellip;': '\\ldots',

    // Fraction glyphs
    '&frac12;': '\\frac{1}{2}',
    '&frac14;': '\\frac{1}{4}',
    '&frac34;': '\\frac{3}{4}',

    // Miscellaneous glyphs
    '&deg;': '^{\\circ}',
    '&micro;': '\\mu',

    // Lowercase Greek letters
    '&alpha;': '\\alpha',
    '&beta;': '\\beta',
    '&gamma;': '\\gamma',
    '&delta;': '\\delta',
    '&epsilon;': '\\epsilon',
    '&zeta;': '\\zeta',
    '&eta;': '\\eta',
    '&theta;': '\\theta',
    '&iota;': '\\iota',
    '&kappa;': '\\kappa',
    '&lambda;': '\\lambda',
    '&mu;': '\\mu',
    '&nu;': '\\nu',
    '&xi;': '\\xi',
    '&omicron;': 'o',
    '&pi;': '\\pi',
    '&rho;': '\\rho',
    '&sigmaf;': '\\sigma',
    '&sigma;': '\\sigma',
    '&tau;': '\\tau',
    '&upsilon;': '\\upsilon',
    '&phi;': '\\phi',
    '&chi;': '\\chi',
    '&psi;': '\\psi',
    '&omega;': '\\omega',

    // Uppercase Greek letters with LaTeX commands
    '&Gamma;': '\\Gamma',
    '&Delta;': '\\Delta',
    '&Theta;': '\\Theta',
    '&Lambda;': '\\Lambda',
    '&Xi;': '\\Xi',
    '&Pi;': '\\Pi',
    '&Sigma;': '\\Sigma',
    '&Upsilon;': '\\Upsilon',
    '&Phi;': '\\Phi',
    '&Psi;': '\\Psi',
    '&Omega;': '\\Omega',

    // Logical and set operators
    '&forall;': '\\forall',
    '&exist;': '\\exists',
    '&nabla;': '\\nabla',
    '&infin;': '\\infty',
    '&and;': '\\wedge',
    '&or;': '\\vee',
    '&cap;': '\\cap',
    '&cup;': '\\cup',
    '&int;': '\\int',
    '&sum;': '\\sum',
    '&prod;': '\\prod',
    '&there4;': '\\therefore',
    '&part;': '\\partial',
    '&prop;': '\\propto',

    // Relations
    '&isin;': '\\in',
    '&notin;': '\\notin',
    '&ni;': '\\ni',
    '&sub;': '\\subset',
    '&sup;': '\\supset',
    '&sube;': '\\subseteq',
    '&supe;': '\\supseteq',
    '&oplus;': '\\oplus',
    '&otimes;': '\\otimes',
    '&perp;': '\\perp',

    // Directional arrows
    '&larr;': '\\leftarrow',
    '&rarr;': '\\rightarrow',
    '&uarr;': '\\uparrow',
    '&darr;': '\\downarrow',
    '&harr;': '\\leftrightarrow',
    '&lArr;': '\\Leftarrow',
    '&rArr;': '\\Rightarrow',
    '&uArr;': '\\Uparrow',
    '&dArr;': '\\Downarrow',
    '&hArr;': '\\Leftrightarrow',
    // Return arrow is less common; fall back to a plain left arrow
    '&crarr;': '\\leftarrow',
  },
};

export default HTML_ENTITY_REPLACEMENTS;
