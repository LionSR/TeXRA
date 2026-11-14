// Third-party imports
import { String as Str } from 'effect';

// Local imports - replacement
import {
  GREEK_LETTERS,
  LATEX_ENVIRONMENTS,
  LETTERS,
  MATH_OPERATORS,
  SECTION_TYPES,
  UPPERCASE_GREEK_LETTER_CHARACTERS,
  UPPERCASE_LETTERS,
} from '@replacement/constants';
import {
  createPatterns,
  generateBackslashFixes,
  generateLegacyFontFixes,
  type PatternDict,
} from '@replacement/patterns';

/**
 * Generates patterns for non-breaking spaces in references
 */
function generateReferenceSpacing(referenceTypes: string[]): PatternDict {
  return createPatterns(referenceTypes, (type) => {
    const entries: [string, string][] = [[`${type} \\ref{`, `${type}~\\ref{`]];
    if (/^[a-z]/.test(type)) {
      const capitalizedType = Str.capitalize(type);
      entries.push(
        [`${capitalizedType} \\ref{`, `${capitalizedType}~\\ref{`],
        [`${capitalizedType}\\ref{`, `${capitalizedType}~\\ref{`],
      );
    }
    return entries;
  });
}

/** The spellings of a blank line the line-break fixes collapse to one break. */
const BLANK_LINES = ['\n\n', '\n    \n', '\n\t\n'];

export const CHARACTER_REPLACEMENTS: PatternDict = {
  ansätze: 'ans{\\"a}tze',
  Rényi: "R{\\'e}nyi",
  Schrödinger: 'Schr{\\"o}dinger',
  // Covers the plural too: the singular rewrite leaves the trailing 's'.
  'Schr{\\\\`o}dinger': 'Schr{\\"o}dinger',
};

// Common LaTeX equation spacing fixes
export const EQUATION_REPLACEMENTS: PatternDict = (() => {
  // ===== Linebreak fixes within environments =====
  // Examples:
  // \n\n\end{align} -> \n\end{align}
  // \n    \n\end{aligned} -> \n\end{aligned}
  const linebreakFixesPatterns = createPatterns(['align', 'aligned'], (env) =>
    BLANK_LINES.map((blank): [string, string] => [
      `${blank}\\end{${env}}`,
      `\n\\end{${env}}`,
    ]),
  );

  // ===== Reference formatting =====
  // Examples:
  // figure \ref{ -> figure~\ref{
  // Table \ref{ -> Table~\ref{
  const referencePatterns = generateReferenceSpacing([
    'Figure',
    'figure',
    'Table',
    'table',
    'Eq.',
    'Eqs.',
    'Eqns.',
    'equation',
    'eq.',
    'eqn.',
  ]);

  // ===== Backslash fixes =====
  const backslashFixPatterns = generateBackslashFixes([
    // Math operators
    ...MATH_OPERATORS,
    'pi',
    'bna',
    // Greek letters
    ...GREEK_LETTERS,
    'partial',
    'Delta',
    'Gamma',
    'Lambda',
    'Sigma',
    'Omega',
    // Delimiters
    ...'left right left( right( left[ right['.split(' '),
    // Math commands
    ...'frac sum_ prod_ int_ oint_ nabla'.split(' '),
    // Integrals
    ...'int iint iiint oint ooint ooooint'.split(' '),
    // Dots
    ...'cdot dot ldots cdots vdots ddots iddots'.split(' '),
    // Formatting commands
    ...`
      mathbf mathbb mathcal mathscr bm
      sum prod infty rightarrow leftarrow Rightarrow
      Leftarrow exists forall der
    `
      .trim()
      .split(/\s+/),
    // Formatting commands with their opening brace
    ...`
      text{ tilde{ textit{ textbf{ emph{ underline{
      overbrace{ underbrace{ label{
    `
      .trim()
      .split(/\s+/),
  ]);

  // Greek letter notation fixes
  // Examples: \a_ -> a_, \a^ -> a^
  // 'x' is deliberately absent: '\x' is a defined shortcut macro
  // (katexMacros), so '\x_' -> 'x_' would strip it.
  const letters = [...'abcdefghijklmnopqrstuvwyz'];
  const letterNotationFixes = createPatterns(letters, (letter) => [
    [`\\${letter}_`, `${letter}_`],
    [`\\${letter}^`, `${letter}^`],
  ]);

  // Environment end command fixes
  // Examples: \n\\nend{align} -> \n\end{align}
  const environments =
    'align equation itemize enumerate figure tikzpicture document'.split(' ');
  const envEndFixes = createPatterns(environments, (env) => [
    [`\n\\\nend{${env}}`, `\n\\end{${env}}`],
  ]);

  // Environment braces/brackets fixes
  // Examples: {\align} -> {align}
  const bracesFixes = createPatterns(environments, (env) => [
    [`{\\${env}}`, `{${env}}`],
  ]);

  return {
    ...linebreakFixesPatterns,
    ...referencePatterns,
    ...backslashFixPatterns,
    ...letterNotationFixes,
    ...envEndFixes,
    ...bracesFixes,

    // Additional specific Greek letter fixes
    '\\\\\\rho': '\\rho',
    '\\\\\\delta': '\\delta',

    // Additional specific fixes for rho
    '\\\\rho_': '\\rho_',
    '\\\\rho^': '\\rho^',
    '\\\\rho\\': '\\rho\\',

    // Fix line breaks in delimiters
    '\\right\n)': '\\right)',
    '\\right\n]': '\\right]',
    '\\right\n}': '\\right}',
    '\\left\n(': '\\left(',
    '\\left\n[': '\\left[',
    '\\left\n{': '\\left{',

    // Fix variable notations with wrong backslashes
    '\\\\e^': 'e^',

    // Label spacing fixes
    ',    \\label{': ',\\label{',
    ',  \\label{': ',\\label{',
    ',        \\label{': ',\\label{',
    '\\\nlabel{': '\\label{',

    // Environment name fixes
    '\\end{Galign}': '\\end{align}',

    ':\\colon': '\\colon',
  };
})();

export const FONT_COMMAND_REPLACEMENTS: PatternDict = {
  ...generateLegacyFontFixes(LETTERS, ['rm', 'bf', 'it', 'sf', 'tt']),
  ...generateLegacyFontFixes(UPPERCASE_LETTERS, ['cal']),
};

// These commands (e.g. \end{section}) never appear in valid LaTeX.
export const LATEX_FORBIDDEN_REPLACEMENTS: PatternDict = createPatterns(
  SECTION_TYPES,
  (sectionType) =>
    [
      `\\end{${sectionType}}`,
      `\\end{${sectionType}*}`,
      `\\end {${sectionType}}`,
      `\\end {${sectionType}*}`,
      `\\end{ ${sectionType}}`,
      `\\end{ ${sectionType}*}`,
      `\\end{${sectionType} }`,
      `\\end{${sectionType}* }`,
      `\\end { ${sectionType} }`,
      `\\end { ${sectionType}* }`,
    ].map((ending): [string, string] => [ending, '']),
);

export const GPTNESS_REPLACEMENTS: PatternDict = {
  'delve into': 'discuss',
  'delves into': 'discusses',
  'delving into': 'discussing',
  disparate: 'different',
  disseminates: 'distributes',
  disseminated: 'distributed',
  disseminating: 'distributing',
  dissemination: 'distribution', // also covers the plural

  parsimonious: 'simple',
  embark: 'start',
  realm: 'area',
  intricate: 'complex',
  '"exact"': "``exact''",

  "It's important to note": 'Note that',
  'our exploration': 'our discussion',
  'inter-layer': 'interlayer',
  'Near the 50\\%': 'Near 50\\%',
  'on the order of': 'of the order of',
  'improves consistently': 'consistently improves',
  'with results shown': 'with the results shown',
  'imaginary time evolution': 'imaginary-time evolution',
  showcasing: 'showing',
  'paradigm shift': 'big change',
  envisage: 'imagine',
  Normalising: 'Normalizing',
  conditon: 'condition',
  necessitates: 'requires',
  Itô: 'Ito',
  k_BT: 'k_B T',

  // Sophisticated single words
  myriad: 'many',
  multitude: 'many',
  amalgamation: 'combination',
  culminate: 'end',
  expedite: 'speed up',
  leverage: 'use',
  commence: 'begin',
  elucidate: 'explain',
  ascertain: 'determine',
  paramount: 'important',
  quintessential: 'essential',
  imperative: 'important',
  peruse: 'read',
  cognizant: 'aware',
  nascent: 'new',
  ostensibly: 'apparently',
  conundrum: 'problem',
  efficacy: 'effectiveness',
  deleterious: 'harmful',
  salient: 'prominent',
  precipitate: 'cause', // as a verb
  ubiquitous: 'common',
  underscore: 'emphasize',
  proffer: 'offer',
  surmise: 'guess',
  burgeon: 'grow',
  expound: 'explain',

  // LaTeX packages:
  ',amsth,': ',amsthm,',

  // Sophisticated or formal GPT expressions
  'it is imperative to': 'we must',
  'it is paramount that': 'it is crucial that',
  'of paramount importance': 'very important',
  'it is incumbent upon us to': 'we should',
  'the crux of the matter is': 'the main point is',
  'in light of the fact that': 'because',
  'by virtue of the fact that': 'because',
  'aforementioned discussion': 'this discussion',
  'in the affirmative': 'yes',
  'in the negative': 'no',
  'serves to illustrate': 'shows',
  'render it necessary to': 'require',
  'exhibits a tendency to': 'tends to',
  'have a bearing on': 'affect',
  'bear resemblance to': 'resemble',
  'in consequence of': 'because of',
  'subsequent to our analysis': 'after our analysis',

  // Additional Formal GPT Expressions based on feedback
  'it stands to reason that': 'it follows that', // or 'logically'
  'at this juncture': 'now', // or 'at this point'
  'in the first instance': 'firstly',
  'for the duration of': 'during',
  'be that as it may': 'however', // or 'despite that'
  'make endeavors to': 'try to',
  'is indicative of': 'indicates',
  'holds true for': 'applies to',
  'bring to fruition': 'complete', // or 'achieve'

  // Top GPT-isms (marketing/cliche phrases)
  'dive deeper into': 'study',
  'harness the power': 'use',
  'seamlessly integrate': 'integrate',
  'leveraging the capabilities': 'using',
  'ultimate guide to': 'guide to',
  'mastering the art of': 'learning',
  'empower you to': 'help you',

  // Additional GPT-isms
  brittle: 'fragile',
};

export const HTML_ENTITY_REPLACEMENTS: PatternDict = {
  // Angle brackets often appear when XML tags are HTML-escaped
  '&lt;': '<',
  '&gt;': '>',

  // Ampersands should be escaped in LaTeX to avoid alignment issues
  '&amp;': '\\&',

  // Quotes and spacing
  '&quot;': '"',
  '&apos;': "'",
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

  // Greek letters: &alpha; -> \alpha. LaTeX has no \omicron, and the
  // final sigma is a sigma.
  ...createPatterns(GREEK_LETTERS, (name) => [[`&${name};`, `\\${name}`]]),
  '&omicron;': 'o',
  '&sigmaf;': '\\sigma',
  ...createPatterns(Object.keys(UPPERCASE_GREEK_LETTER_CHARACTERS), (name) => [
    [`&${name};`, `\\${name}`],
  ]),

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
};

export const LATEX_XML_REPLACEMENTS: PatternDict = (() => {
  // Pure XML tags that should not be treated as LaTeX environments.
  const pureXmlTags = [
    'revised_statement',
    'scratchpad',
    'idea',
    'cover_letter',
    'reflection',
    'rebuttal_package',
    'beamer_poster',
  ];

  return {
    // ===== XML to LaTeX conversions =====
    // Examples:
    // <align> -> \begin{align}
    // </tikzpicture> -> \end{tikzpicture}
    // <figure}> -> \begin{figure}
    ...createPatterns(LATEX_ENVIRONMENTS, (env) => [
      // XML to LaTeX
      [`<${env}>`, `\\begin{${env}}`],
      [`</${env}>`, `\\end{${env}}`],
      // XML with begin to LaTeX
      [`<begin{${env}}>`, `\\begin{${env}}`],
      [`</begin{${env}}>`, `\\end{${env}}`],
      // XML with end to LaTeX
      [`<end{${env}}>`, `\\end{${env}}`],
      [`</end{${env}}>`, `\\end{${env}}`],
      // XML with braces to LaTeX. Newline-suffixed spellings (`</env}\n`,
      // `</begin{env}\n`) need no entry of their own: the entries below run
      // first, rewrite the tag, and leave the trailing newline untouched.
      [`<${env}}`, `\\begin{${env}}`],
      [`</${env}}`, `\\end{${env}}`],
      [`</${env}\n`, `\\end{${env}}\n`],
      // XML begin tags incorrectly closed with leading slash
      [`</begin{${env}}`, `\\begin{${env}}`],
      [`</begin{${env}`, `\\begin{${env}}`],
      // LaTeX with incorrect XML ending
      [`\\end{${env}>}`, `\\end{${env}}`],
      [`\\end{${env}>`, `\\end{${env}}`],
      // LaTeX with incorrect labels
      [`\\begin{-${env}}`, `\\begin{${env}}`],
      [`\\end{-${env}}`, `\\end{${env}}`],
      // LaTeX with incorrect XML ending
      [`\\begin${env}`, `\\begin{${env}}`],
      [`\\end${env}`, `\\end{${env}}`],
      // LaTeX with duplicated begin/end keywords
      [`\\begin{begin{${env}}`, `\\begin{${env}}`],
      [`\\begin{begin{${env}}}`, `\\begin{${env}}`],
      [`\\begin{\\begin{${env}}`, `\\begin{${env}}`],
      [`\\begin{\\begin{${env}}}`, `\\begin{${env}}`],
      [`\\end{end{${env}}`, `\\end{${env}}`],
      [`\\end{end{${env}}}`, `\\end{${env}}`],
      [`\\end{\\end{${env}}`, `\\end{${env}}`],
      [`\\end{\\end{${env}}}`, `\\end{${env}}`],
    ]),

    // ===== LaTeX to XML conversions =====
    // Examples:
    // \begin{scratchpad} -> <scratchpad>
    // \end{scratchpad} -> </scratchpad>
    ...createPatterns(pureXmlTags, (tag) => [
      [`\\begin{${tag}}`, `<${tag}>`],
      [`\\end{${tag}}`, `</${tag}>`],
      // LaTeX with '>' at the end to XML
      [`\\begin{${tag}>}`, `<${tag}>`],
      [`\\begin{${tag}>`, `<${tag}>`],
      [`\\end{${tag}>}`, `</${tag}>`],
      [`\\end{${tag}>`, `</${tag}>`],
    ]),

    // LaTeX tags closed as XML-style end tags with a trailing '>'; the
    // plain `\end{env>}`/`\end{env>` spellings already come from
    // the XML to LaTeX conversions above.
    ...createPatterns(LATEX_ENVIRONMENTS, (env) => [
      [`</end{${env}>`, `\\end{${env}}`],
    ]),

    // XML tags with an extra brace stay XML
    ...createPatterns(pureXmlTags, (tag) => [
      [`<${tag}}`, `<${tag}>`],
      [`</${tag}}`, `</${tag}>`],
    ]),

    // Special cases for minipage. The literal `\n`-prefixed spelling needs no
    // entry of its own: this rule rewrites the tag and leaves the prefix.
    '\\minipage}': '\\end{minipage}',

    // Special case for item tag
    '<item>': '\\item',
    '</item>': '',

    // Extra braces in LaTeX environment tags
    '\\begin{figure*}}': '\\begin{figure*}',
    '\\begin{figure}}': '\\begin{figure}',

    // An empty name attribute breaks the named-document fallback in extraction.
    '<document name="">': '<document name="unknown">',

    // Stray XML noise emitted by some models
    '<?xml version="1.0" encoding="UTF-8"?>': '',
    '```xml\n': '',
    '</xml>': '',
  };
})();

// A blank line latexdiff leaves before the closing brace of a starred
// environment: \n\n}\end{align*}%DIFAUXCMD -> \n}\end{align*}%DIFAUXCMD
export const LATEXDIFF_REPLACEMENTS: PatternDict = createPatterns(
  ['align*', 'aligned*'],
  (env) =>
    BLANK_LINES.map((blank): [string, string] => [
      `${blank}}\\end{${env}}%DIFAUXCMD`,
      `\n}\\end{${env}}%DIFAUXCMD`,
    ]),
);

export const PERSONAL_STYLE_REPLACEMENTS: PatternDict = {
  // ===== Spacing preferences =====
  // Consistent spacing for math mode and delimiters
  // Note: '\\;' replacements are in latex_spacing category to avoid duplication
  ' \\, d\\': '~ d\\',
  ' \\,|': ' |',
  '|\\, ': '| ',
  ' \\,  ': ' ',
  '  \\, ': ' ',
  ' \\, ': ' ',
  '\\, \\,': ' \\,',

  // ===== Hyphenation and compound term preferences =====
  // Physical Review style compound term formatting
  nonnegative: 'non-negative',
  finitetime: 'finite-time',
  'one–step': 'one-step',
  'multi-scale': 'multiscale',
  'area law scaling': 'area-law scaling',
  'machine learning model': 'machine-learning model',
  'machine learning task': 'machine-learning task',

  // ===== Spelling standardization =====
  // Convert UK to US spelling
  analogue: 'analog',

  // ===== Reference formatting =====
  // Add non-breaking spaces for references (chktex compatibility)
  ...generateReferenceSpacing([
    'Appendix',
    'Section',
    'Figure',
    'Table',
    'Equation',
    'Theorem',
    'Lemma',
    'Corollary',
  ]),

  // ===== Math operator standardization =====
  // Preferred operator command forms
  '\\mathrm{KL}': '\\KL',

  // ===== Reference formatting =====
  // Add non-breaking spaces for references (chktex compatibility)
  'in~\\cref{': 'in \\cref{',
  'In~\\cref{': 'In \\cref{',
  'in~Sec': 'in Sec',
  'In~Sec': 'In Sec',
  // The bare 'Eq' forms also cover 'Eqs'/'Eqs.': only the tilde is rewritten,
  // so the trailing characters are carried through untouched.
  'by~Eq': 'by Eq',
  'see~Sec': 'see Sec',
  'See~Sec': 'See Sec',
  'from~Eq': 'from Eq',
  'From~Eq': 'From Eq',
  'cf.~Eq': 'cf. Eq',
  'to~App': 'to App',
  '~(\\ref{': ' (\\ref{',
  'form \\cref': 'from \\cref',
  ' ~\\citep{': ' \\citep{',
  ' ~\\citet{': ' \\citet{',
};

// Examples:
// \end{align}\n\section -> \end{align}\n\n\n\section
// \end{equation}\n\paragraph -> \end{equation}\n\n\n\paragraph
export const SECTION_REPLACEMENTS: PatternDict = createPatterns(
  ['align', 'equation'],
  (env) =>
    SECTION_TYPES.slice(0, 3).map((sectionType): [string, string] => [
      `\\end{${env}}\n\\${sectionType}`,
      `\\end{${env}}\n\n\n\\${sectionType}`,
    ]),
);

// LaTeX spacing and punctuation fixes
export const LATEX_SPACING_REPLACEMENTS: PatternDict = {
  // ===== Basic spacing fixes =====
  // Remove unnecessary spacing commands
  ' \\; ': ' ',
  ', \\;': ', ',
  ' \\;': ' ',
  '\\;': ' ',
  '\\,\n': '\n',
  '\\!\\!': '',

  // Line breaks and indentation fixes
  ' \\,\\nn': ' \\nn',
  '\n    \\\\': '\\\\',
  ' nn\n': ' \\nn\n',
  ' .\n': '.\n',
  ' ,\\nn\\\\\n': ',\\nn\\\\\n',

  // Multiple space fixes
  '.  ': '. ',

  // ===== Comma spacing fixes =====
  // Note: ',\,\' -> ', \' preserves the trailing backslash (start of next command)
  ',\\,\\': ', \\',
  ')\\,\\': ') \\',
  '}\\,\\': '} \\',
  '|\\,\\': '| \\',
  ' \\,\\': ' \\',

  // ===== Operator spacing =====
  '\\;+\\;': '+',
  '\\;-\\;': '-',
  '\\;*\\;': '*',
  '\\;/\\;': '/',
  '\\;=\\;': '=',
  ' \\,=\\, ': ' = ',
  ' \\,:=\\, ': ' := ',
  ' \\=\\ ': ' = ',
  ' \\ :=\\ ': ' := ',
  ' \\,\\equiv\\, ': ' \\equiv ',
  ' \\equiv\\ ': ' \\equiv ',
  '+\\;': '+',
  '-\\;': '-',
  '=\\;': '=',

  // ===== Align environment formatting =====
  '\n    \\nonumber\\\\': '\\nonumber\\\\',
  '\n    +': ' +',
  '\n    \n&=': '\n    &=',
  '\n    ,\n': ',\n',
  '\\!\n    ': '\n    ',
  '\n    =\n': ' =',
  '\n     &\n    -': '\n    & -',
  '(\n    ': '(',
  '\n    )': ')',
  '\n     &\n    \\times': '\n    & \\times',

  // ===== Complex math expression spacing =====
  // Exponential expressions
  'e^{\\,i\\,': 'e^{i ',
  'e^{\\,': 'e^{',
  '-\\,i\\, ': '-i ',
  '-\\,i\\,': '-i',
  '\\,i\\,': ' i ',

  // Negative sign handling
  '-\\,': '-',
  '\\,&': ' &',
  '{-\\,0}': '{0}',
  '{-\\,1}': '{1}',

  // Math operator spacing
  '\\!\\left\\!': ' \\left ',
  '\\!\\cdot\\!': ' \\cdot ',
  '\\!\\ldots\\!': ' \\ldots ',
  '\\!\\cdots\\!': ' \\cdots ',
  '\\!\\vdots\\!': ' \\vdots ',
  '\\!\\ddots\\!': ' \\ddots ',

  // ===== Symbol separator handling =====
  // Vertical bars and other delimiters
  ')\\!\\|': ') \\|',
  '}\\!\\|': '} \\|',
  ')\\!\\': ') \\',
  '}\\!\\': '} \\',

  // ===== Vertical spacing commands =====
  // Remove unnecessary skip commands
  '\\medskip\n': '',
  '\\smallskip\n': '',
  '\\bigskip\n': '',

  // ===== Math mode punctuation =====
  // Move punctuation outside math mode
  '.$': '$.',
  '$-\\,': '$-',

  // ===== Delimiter simplification =====
  '\\left[\\dots\\right]': '[\\dots]',

  // ===== Display style commands =====
  '\\displaystyle': '',

  // ===== O1/O3 model specific fixes =====
  '=    \\': '= \\',
  ' rho_': '  \\rho_',
  ' rho^': '  \\rho^',
  ' rho\\': '  \\rho\\',

  // ===== Math limits formatting =====
  '\\sum\\limits_': '\\sum_',
};

/** Every character from `first` to `last`, by code point. */
function characterRange(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, i) =>
    String.fromCodePoint(first + i),
  );
}

export const UNICODE_REPLACEMENTS: PatternDict = {
  // En dash, non-breaking hyphen, em dash and hyphen to an ASCII hyphen. The
  // minus sign U+2212 is converted in math by replaceMathUnicode.
  '–': '-',
  '‑': '-',
  '—': '-',
  '‐': '-',

  // Curly quotes, and the letters models misuse as apostrophes (modifier
  // apostrophe, right half ring, Armenian apostrophe), to ASCII quotes.
  '’': "'",
  '‘': "'",
  '”': '"',
  '“': '"',
  ʼ: "'",
  ʾ: "'",
  '՚': "'",

  ' ': '~', // no-break space
  '…': '...',
  // The typographic spaces, en quad through hair space.
  ...createPatterns(characterRange(0x2000, 0x200a), (c) => [[c, ' ']]),

  // Invisible characters: soft hyphen, Mongolian vowel separator, zero-width
  // spaces and joiners, bidirectional marks, embeddings, overrides and
  // isolates, word joiner, byte order mark.
  ...createPatterns(
    [
      '­',
      '᠎',
      ...characterRange(0x200b, 0x200f),
      ...characterRange(0x202a, 0x202e),
      '⁠',
      ...characterRange(0x2066, 0x2069),
      '﻿',
    ],
    (c) => [[c, '']],
  ),

  '•': '*',
  '½': '1/2',
  '✓': '\\checkmark',

  // Accented Latin letters to LaTeX accent commands.
  á: "\\'a",
  é: "\\'e",
  í: "\\'i",
  ó: "\\'o",
  ú: "\\'u",
  à: '\\`a',
  è: '\\`e',
  ì: '\\`i',
  ò: '\\`o',
  ù: '\\`u',
  â: '\\^a',
  ê: '\\^e',
  î: '\\^i',
  ô: '\\^o',
  û: '\\^u',
  ä: '\\"a',
  ë: '\\"e',
  ï: '\\"i',
  ü: '\\"u',
  ã: '\\~a',
  ñ: '\\~n',
  õ: '\\~o',
  Á: "\\'A",
  É: "\\'E",
  Ó: "\\'O",
  Ô: '\\^O',
  Ö: '\\"O',
  Ã: '\\~A',
  Ō: '\\=O',
  ō: '\\=o',
  Ç: '\\c C',
  ç: '\\c c',

  // Cyrillic homoglyphs (о, е, а) to the Latin letters they imitate.
  о: 'o',
  е: 'e',
  а: 'a',

  // A Greek mu after a closing $ starts a unit: wrap it in math.
  '$ μs': '$ $\\mu$s',
  '$ μm': '$ $\\mu$m',
  '$ μA': '$ $\\mu$A',
  '$ μV': '$ $\\mu$V',
  '$ μW': '$ $\\mu$W',
  '$ μT': '$ $\\mu$T',
  '$ μH': '$ $\\mu$H',
  '$ μF': '$ $\\mu$F',
};
