// Local imports - replacement
import {
  GREEK_LETTERS,
  LATEX_ENVIRONMENTS,
  MATH_OPERATORS,
  SECTION_TYPES,
} from '@replacement/constants';
import {
  generateBackslashFixes,
  generateEnvironmentBracesFixes,
  generateEnvironmentLinebreakFixes,
  generateInvalidSectionEndingFixes,
  generateLatexToXmlConversions,
  generateReferenceSpacing,
  generateSectionSpacingFixes,
  generateXmlLatexConversions,
} from '@replacement/helpers';
import { NonRegexReplacementCategory } from '@replacement/types';
import type { NonRegexReplacementCategory as NonRegexReplacementCategoryName } from '@shared/constants/replacementCategories';

export const CHARACTER_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'characters' satisfies NonRegexReplacementCategoryName,
  description: 'Fixes for special characters and diacritics',
  isRegex: false,
  patterns: {
    ansätze: 'ans{\\"a}tze',
    Rényi: "R{\\'e}nyi",
    Schrödinger: 'Schr{\\"o}dinger',
    'Schr{\\\\`o}dinger': 'Schr{\\"o}dinger',
    'Schr{\\\\`o}dingers': 'Schr{\\"o}dingers',
  },
};

// Common LaTeX equation spacing fixes
export const EQUATION_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'equations' satisfies NonRegexReplacementCategoryName,
  description: 'Fixes for LaTeX equation spacing and formatting',
  isRegex: false,
  patterns: (() => {
    // ====================================================================
    // Auto-generated replacements - for easily maintainable pattern groups
    // ====================================================================

    // ===== Linebreak fixes within environments =====
    // Examples:
    // \n\n\end{align} -> \n\end{align}
    // \n    \n\end{aligned} -> \n\end{aligned}
    const linebreakFixesPatterns = generateEnvironmentLinebreakFixes(
      'align aligned'.split(' '),
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

    // ===== Grouped backslash fixes =====
    // Grouped only for readability; every group is fixed the same way.
    const backslashCommandGroups = {
      mathOperators: [...MATH_OPERATORS, 'pi', 'bna'],
      greekLetters: [
        ...GREEK_LETTERS,
        'partial',
        'Delta',
        'Gamma',
        'Lambda',
        'Sigma',
        'Omega',
      ],
      delimiters: 'left right left( right( left[ right['.split(' '),
      mathCommands: 'frac sum_ prod_ int_ oint_ nabla'.split(' '),
      integrals: 'int iint iiint oint ooint ooooint'.split(' '),
      dots: 'cdot dot ldots cdots vdots ddots iddots'.split(' '),
      formattingCommands: `
        mathbf mathbb mathcal mathscr bm
        sum prod lim infty rightarrow leftarrow Rightarrow
        Leftarrow exists forall der partial Delta Gamma Lambda Sigma Omega
      `
        .trim()
        .split(/\s+/),
      formattingWithBraces: `
        text{ tilde{ textit{ textbf{ emph{ underline{
        overbrace{ underbrace{ label{
      `
        .trim()
        .split(/\s+/),
    };
    const groupedBackslashPatterns = generateBackslashFixes(
      Object.values(backslashCommandGroups).flat(),
    );

    // Greek letter notation fixes
    // Examples: \a_ -> a_, \a^ -> a^
    const letters = [...'abcdefghijklmnopqrstuvwyz'];
    const letterNotationFixes = Object.fromEntries(
      letters.flatMap((letter) => [
        [`\\${letter}_`, `${letter}_`],
        [`\\${letter}^`, `${letter}^`],
      ]),
    );

    // Environment end command fixes
    // Examples: \n\\nend{align} -> \n\end{align}
    const environments =
      'align equation itemize enumerate figure tikzpicture document'.split(' ');
    const envEndFixes = Object.fromEntries(
      environments.map((env) => [`\n\\\nend{${env}}`, `\n\\end{${env}}`]),
    );

    // Environment braces/brackets fixes
    // Examples: {\align} -> {align}
    const bracesFixes = generateEnvironmentBracesFixes(environments);

    return {
      ...linebreakFixesPatterns,
      ...referencePatterns,
      ...groupedBackslashPatterns,
      ...letterNotationFixes,
      ...envEndFixes,
      ...bracesFixes,

      // =================================================================
      // Manual replacements - for cases that need special handling
      // =================================================================

      // Note: latexdiff compatibility fixes moved to dedicated LATEXDIFF_REPLACEMENTS category

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
  })(),
};

export const FONT_COMMAND_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'font_commands' satisfies NonRegexReplacementCategoryName,
  description: 'Normalize deprecated font commands to modern equivalents',
  isRegex: false,
  patterns: {
    ...Object.fromEntries(
      [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].flatMap(
        (letter) => [
          [`{\\rm ${letter}}`, `\\mathrm{${letter}}`],
          [`{\\bf ${letter}}`, `\\mathbf{${letter}}`],
          [`{\\it ${letter}}`, `\\mathit{${letter}}`],
          [`{\\sf ${letter}}`, `\\mathsf{${letter}}`],
          [`{\\tt ${letter}}`, `\\mathtt{${letter}}`],
        ],
      ),
    ),
    ...Object.fromEntries(
      [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => [
        `{\\cal ${letter}}`,
        `\\mathcal{${letter}}`,
      ]),
    ),
  },
};

export const LATEX_FORBIDDEN_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'latex_forbidden_commands' satisfies NonRegexReplacementCategoryName,
  description:
    'Removes LaTeX commands that should never appear, such as section endings',
  isRegex: false,
  patterns: generateInvalidSectionEndingFixes(SECTION_TYPES),
};

export const GPTNESS_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'gptness' satisfies NonRegexReplacementCategoryName,
  description: 'GPTness improvements',
  isRegex: false,
  patterns: {
    'delve into': 'discuss',
    'delves into': 'discusses',
    'delving into': 'discussing',
    disparate: 'different',
    disseminates: 'distributes',
    disseminated: 'distributed',
    disseminating: 'distributing',
    dissemination: 'distribution',
    disseminations: 'distributions',
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
    // parameterizing: 'parametrizing',
    Normalising: 'Normalizing',
    conditon: 'condition',
    necessitates: 'requires',
    Itô: 'Ito',
    k_BT: 'k_B T',

    // Sophisticated single words (user curated)
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

    // Sophisticated/Formal GPT Expressions (user curated)
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
    // 'in accordance with': 'according to', // or 'following'
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
    // 'deeper understanding': 'better understanding',
    // 'are essential': 'are important',
    // novel: 'new',
    // explore: 'study',
    // fostering: 'promoting',
    // pivotal: 'important',
  },
};

export const HTML_ENTITY_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'html_entities' satisfies NonRegexReplacementCategoryName,
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

export const LATEX_XML_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'latex_xml' satisfies NonRegexReplacementCategoryName,
  description: 'Fixes specific to XML output processing',
  isRegex: false,
  patterns: (() => {
    // ====================================================================
    // Auto-generated replacements - for easily maintainable pattern groups
    // ====================================================================

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
      ...generateXmlLatexConversions(LATEX_ENVIRONMENTS),

      // ===== LaTeX to XML conversions =====
      // Examples:
      // \begin{scratchpad} -> <scratchpad>
      // \end{scratchpad} -> </scratchpad>
      ...generateLatexToXmlConversions(pureXmlTags),

      // =================================================================
      // Manual replacements - for cases that need special handling
      // =================================================================

      // ===== 1. LATEX TAG ENDING FIXES =====
      // Fix LaTeX tags closed as XML-style end tags with a trailing '>'; the
      // plain `\end{env>}`/`\end{env>` spellings already come from
      // generateXmlLatexConversions above.
      ...Object.fromEntries(
        LATEX_ENVIRONMENTS.map((env) => [`</end{${env}>`, `\\end{${env}}`]),
      ),

      // ===== 2. XML BRACE FIXES =====
      // Fix XML tags with extra braces that remain as XML
      ...Object.fromEntries(
        pureXmlTags.flatMap((tag) => [
          [`<${tag}}`, `<${tag}>`],
          [`</${tag}}`, `</${tag}>`],
        ]),
      ),

      // ===== 3. Special Case Handling =====
      // Special cases for minipage
      '\\minipage}': '\\end{minipage}',
      '\\n\\minipage}': '\\n\\end{minipage}',

      // Special case for item tag
      '<item>': '\\item',
      '</item>': '',

      // ===== 6. LATEX BRACE FIXES =====
      // Fix extra braces in LaTeX environment tags
      '\\begin{figure*}}': '\\begin{figure*}',
      '\\begin{figure}}': '\\begin{figure}',

      // ===== 7. Unified <documents><document name="..."> hygiene =====
      // Empty name attribute breaks the named-document fallback in extraction.
      '<document name="">': '<document name="unknown">',

      // ===== 8. Stray XML noise emitted by some models =====
      '<?xml version="1.0" encoding="UTF-8"?>': '',
      '```xml\n': '',
      '</xml>': '',
    };
  })(),
};

export const LATEXDIFF_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'latexdiff' satisfies NonRegexReplacementCategoryName,
  description: 'Fixes for LaTeXdiff markup and compatibility issues',
  isRegex: false,
  patterns: {
    // Fix issues with latexdiff markup and excessive newlines
    '\n\n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n    \n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n\t\n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n\n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
    '\n    \n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
    '\n\t\n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
  },
};

export const PERSONAL_STYLE_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'personal_style' satisfies NonRegexReplacementCategoryName,
  description:
    'Personal writing style preferences for specific LaTeX commands and spacing',
  isRegex: false,
  patterns: {
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
    'by~Eq': 'by Eq',
    'by~Eqs': 'by Eqs',
    'by~Eqs.': 'by Eqs.',
    'see~Sec': 'see Sec',
    'See~Sec': 'See Sec',
    'from~Eq': 'from Eq',
    'From~Eq': 'From Eq',
    'from~Eqs': 'from Eqs',
    'From~Eqs': 'From Eqs',
    'from~Eqs.': 'from Eqs.',
    'From~Eqs.': 'From Eqs.',
    'cf.~Eq': 'cf. Eq',
    'to~App': 'to App',
    '~(\\ref{': ' (\\ref{',
    'form \\cref': 'from \\cref',
    ' ~\\citep{': ' \\citep{',
    ' ~\\citet{': ' \\citet{',
  },
};

export const SECTION_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'sections' satisfies NonRegexReplacementCategoryName,
  description: 'Fixes for section spacing in LaTeX documents',
  isRegex: false,
  // Examples:
  // \end{align}\n\section -> \end{align}\n\n\n\section
  // \end{equation}\n\paragraph -> \end{equation}\n\n\n\paragraph
  patterns: generateSectionSpacingFixes(
    ['align', 'equation'],
    SECTION_TYPES.slice(0, 3),
  ),
};

// LaTeX spacing and punctuation fixes
export const LATEX_SPACING_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'latex_spacing' satisfies NonRegexReplacementCategoryName,
  description:
    'Fixes for LaTeX spacing, punctuation, and formatting [for O1 model]',
  isRegex: false,
  patterns: {
    // ===== Basic spacing fixes =====
    // Remove unnecessary spacing commands (order matters: longer patterns first)
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
    // Bug fix: previously this was ', ' which stripped backslashes from commands like \phi
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
    '\!\n    ': '\n    ',
    '\n    =\n': ' =',
    '\n    \propto\n': ' =',
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

    // ===== Symbol separator handling =====
    // Vertical bars and other delimiters
    ')\!\|': ') \|',
    '}\!\|': '} \|',
    ')\!\\': ') \\',
    '}\!\\': '} \\',

    // Math operator spacing
    '\!\\left\!': ' \\left ',
    '\!\\cdot\!': ' \\cdot ',
    '\!\\ldots\!': ' \\ldots ',
    '\!\\cdots\!': ' \\cdots ',
    '\!\\vdots\!': ' \\vdots ',
    '\!\\ddots\!': ' \\ddots ',

    // ===== Vertical spacing commands =====
    // Remove unnecessary skip commands
    '\\medskip\n': '',
    '\\smallskip\n': '',
    '\\bigskip\n': '',

    // ===== Math mode punctuation =====
    // Move punctuation outside math mode
    '.$': '$.',
    // ',$': '$,', // this is problematic for eg. tikz figure xticklabels={$-\Sig$,0$,\Sig$},
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
  },
};

export const UNICODE_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'unicode' satisfies NonRegexReplacementCategoryName,
  description:
    'Fixes for common non-math Unicode characters to LaTeX equivalents or for general cleanup (e.g., removing zero-width spaces). Math-specific Unicode is handled by a separate function within math environments.',
  isRegex: false,
  patterns: {
    // ===== Dash and hyphen replacements (globally safe) =====
    '–': '-', // en dash (U+2013) to ASCII hyphen (U+002D)
    '‑': '-', // non-breaking hyphen (U+2011) to ASCII hyphen (U+002D)
    '—': '-', // em dash (U+2014) to ASCII hyphen (U+002D)
    '‐': '-', // HYPHEN (U+2010) to ASCII hyphen (U+002D)
    // Note: Unicode MINUS SIGN U+2212 ('−') is handled by replaceMathUnicode

    // ===== Quote character replacements (globally safe) =====
    '\u2019': "'", // right single quote (U+2019) to ASCII apostrophe
    '\u2018': "'", // left single quote (U+2018) to ASCII apostrophe
    '\u201D': '"', // right double quote (U+201D) to ASCII double quote
    '\u201C': '"', // left double quote (U+201C) to ASCII double quote
    ʼ: "'", // MODIFIER LETTER APOSTROPHE (U+02BC)
    ʾ: "'", // MODIFIER LETTER RIGHT HALF RING (U+02BE) - sometimes misused as quote
    '՚': "'", // ARMENIAN APOSTROPHE (U+055A) - sometimes misused as quote

    // ===== Spacing and Ellipsis =====
    '\u00A0': '~', // Non-breaking space (U+00A0)
    '\u2026': '...', // Horizontal Ellipsis (U+2026) '…' to three periods
    '\u2000': ' ', // EN QUAD (U+2000)
    '\u2001': ' ', // EM QUAD (U+2001)
    '\u2002': ' ', // EN SPACE (U+2002)
    '\u2003': ' ', // EM SPACE (U+2003)
    '\u2004': ' ', // THREE-PER-EM SPACE (U+2004)
    '\u2005': ' ', // FOUR-PER-EM SPACE (U+2005)
    '\u2006': ' ', // SIX-PER-EM SPACE (U+2006)
    '\u2007': ' ', // FIGURE SPACE (U+2007)
    '\u2008': ' ', // PUNCTUATION SPACE (U+2008)
    '\u2009': ' ', // THIN SPACE (U+2009)
    '\u200A': ' ', // HAIR SPACE (U+200A)
    // '\u2028': '\n', // LINE SEPARATOR (U+2028) - User commented out
    // '\u2029': '\n', // PARAGRAPH SEPARATOR (U+2029) - User commented out

    // ===== Suspicious or Invisible Unicode Characters (to be removed) =====
    '\u00AD': '', // Soft Hyphen (U+00AD)
    '\u180E': '', // Mongolian Vowel Separator (U+180E)
    '\u200B': '', // Zero Width Space (U+200B)
    '\u200C': '', // Zero Width Non-Joiner (U+200C)
    '\u200D': '', // Zero Width Joiner (U+200D)
    '\u200E': '', // Left-to-Right Mark (U+200E)
    '\u200F': '', // Right-to-Left Mark (U+200F)
    '\u202A': '', // Left-to-Right Embedding (U+202A)
    '\u202B': '', // Right-to-Left Embedding (U+202B)
    '\u202C': '', // Pop Directional Formatting (U+202C)
    '\u202D': '', // Left-to-Right Override (U+202D)
    '\u202E': '', // Right-to-Left Override (U+202E)
    '\u2060': '', // Word Joiner (U+2060)
    '\u2066': '', // Left-to-Right Isolate (U+2066)
    '\u2067': '', // Right-to-Left Isolate (U+2067)
    '\u2068': '', // First Strong Isolate (U+2068)
    '\u2069': '', // Pop Directional Isolate (U+2069)
    '\uFEFF': '', // Zero Width No-Break Space (BOM) (U+FEFF)

    // ===== Common Symbols to ASCII or simple representation =====
    '\u2022': '*', // BULLET (U+2022) '•' to asterisk
    // '\u00B9': '1', // SUPERSCRIPT ONE (U+00B9) '¹' to '1'
    // '\u00B2': '2', // SUPERSCRIPT TWO (U+00B2) '²' to '2'
    '\u00BD': '1/2', // VULGAR FRACTION ONE HALF (U+00BD) '½' to '1/2'
    '\u2713': '\\checkmark', // CHECK MARK (U+2713) '✓' to \checkmark
    // '™': '\\texttrademark{}', - User commented out
    // '®': '\\textregistered{}', - User commented out
    // '©': '\\textcopyright{}', - User commented out

    // ===== Accented Latin Characters to LaTeX Commands =====
    '\u00E1': "\\'a", // LATIN SMALL LETTER A WITH ACUTE (U+00E1) 'á'
    '\u00E9': "\\'e", // LATIN SMALL LETTER E WITH ACUTE (U+00E9) 'é'
    '\u00ED': "\\'i", // LATIN SMALL LETTER I WITH ACUTE (U+00ED) 'í' (from general knowledge, not in list)
    '\u00F3': "\\'o", // LATIN SMALL LETTER O WITH ACUTE (U+00F3) 'ó'
    '\u00FA': "\\'u", // LATIN SMALL LETTER U WITH ACUTE (U+00FA) 'ú' (from general knowledge, not in list)
    '\u00E0': '\\`a', // LATIN SMALL LETTER A WITH GRAVE (U+00E0) 'à' (from general knowledge, not in list)
    '\u00E8': '\\`e', // LATIN SMALL LETTER E WITH GRAVE (U+00E8) 'è' (from general knowledge, not in list)
    '\u00EC': '\\`i', // LATIN SMALL LETTER I WITH GRAVE (U+00EC) 'ì' (from general knowledge, not in list)
    '\u00F2': '\\`o', // LATIN SMALL LETTER O WITH GRAVE (U+00F2) 'ò' (from general knowledge, not in list)
    '\u00F9': '\\`u', // LATIN SMALL LETTER U WITH GRAVE (U+00F9) 'ù' (from general knowledge, not in list)
    '\u00E2': '\\^a', // LATIN SMALL LETTER A WITH CIRCUMFLEX (U+00E2) 'â' (from general knowledge, not in list)
    '\u00EA': '\\^e', // LATIN SMALL LETTER E WITH CIRCUMFLEX (U+00EA) 'ê' (from general knowledge, not in list)
    '\u00EE': '\\^i', // LATIN SMALL LETTER I WITH CIRCUMFLEX (U+00EE) 'î' (from general knowledge, not in list)
    '\u00F4': '\\^o', // LATIN SMALL LETTER O WITH CIRCUMFLEX (U+00F4) 'ô'
    '\u00FB': '\\^u', // LATIN SMALL LETTER U WITH CIRCUMFLEX (U+00FB) 'û' (from general knowledge, not in list)
    '\u00E4': '\\"a', // LATIN SMALL LETTER A WITH DIAERESIS (U+00E4) 'ä' (from general knowledge, not in list)
    '\u00EB': '\\"e', // LATIN SMALL LETTER E WITH DIAERESIS (U+00EB) 'ë' (from general knowledge, not in list)
    '\u00EF': '\\"i', // LATIN SMALL LETTER I WITH DIAERESIS (U+00EF) 'ï' (from general knowledge, not in list)
    // '\u00F6': '\\"o', // LATIN SMALL LETTER O WITH DIAERESIS (U+00F6) 'ö'
    '\u00FC': '\\"u', // LATIN SMALL LETTER U WITH DIAERESIS (U+00FC) 'ü' (from general knowledge, not in list)
    '\u00E3': '\\~a', // LATIN SMALL LETTER A WITH TILDE (U+00E3) 'ã'
    '\u00F1': '\\~n', // LATIN SMALL LETTER N WITH TILDE (U+00F1) 'ñ' (from general knowledge, not in list)
    '\u00F5': '\\~o', // LATIN SMALL LETTER O WITH TILDE (U+00F5) 'õ' (from general knowledge, not in list)
    '\u00C1': "\\'A", // LATIN CAPITAL LETTER A WITH ACUTE (U+00C1) 'Á' (from general knowledge, not in list)
    '\u00C9': "\\'E", // LATIN CAPITAL LETTER E WITH ACUTE (U+00C9) 'É' (from general knowledge, not in list)
    '\u00D3': "\\'O", // LATIN CAPITAL LETTER O WITH ACUTE (U+00D3) 'Ó' (from general knowledge, not in list)
    '\u00D4': '\\^O', // LATIN CAPITAL LETTER O WITH CIRCUMFLEX (U+00D4) 'Ô' (from general knowledge, not in list)
    '\u00D6': '\\"O', // LATIN CAPITAL LETTER O WITH DIAERESIS (U+00D6) 'Ö' (from general knowledge, not in list)
    '\u00C3': '\\~A', // LATIN CAPITAL LETTER A WITH TILDE (U+00C3) 'Ã' (from general knowledge, not in list)
    '\u014C': '\\=O', // LATIN CAPITAL LETTER O WITH MACRON (U+014C) 'Ō' (from general knowledge, not in list)
    '\u014D': '\\=o', // LATIN SMALL LETTER O WITH MACRON (U+014D) 'ō'
    '\u00C7': '\\c C', // LATIN CAPITAL LETTER C WITH CEDILLA (U+00C7) 'Ç' (from general knowledge, not in list)
    '\u00E7': '\\c c', // LATIN SMALL LETTER C WITH CEDILLA (U+00E7) 'ç' (from general knowledge, not in list)

    // ===== Homoglyph Normalization (Context dependent, use with care) =====
    '\u043E': 'o', // CYRILLIC SMALL LETTER O (U+043E) 'о' to Latin 'o'
    '\u0435': 'e', // CYRILLIC SMALL LETTER IE (U+0435) 'е' to Latin 'e'
    '\u0430': 'a', // CYRILLIC SMALL LETTER A (U+0430) 'а' to Latin 'a' (from general knowledge, not in list)
    // Add more Cyrillic or other homoglyphs here if needed

    // Other math symbols like arrows (→), degree (°), μ (general), ±, ×, ÷
    // are handled by replaceMathUnicode within math environments.

    // ===== Greek letter replacements (moved by user) =====
    // Fix micro unit symbols with proper math mode
    '$ μs': '$ $\\mu$s', // micro (μ U+03BC) to \mu
    '$ μm': '$ $\\mu$m',
    '$ μA': '$ $\\mu$A',
    '$ μV': '$ $\\mu$V',
    '$ μW': '$ $\\mu$W',
    '$ μT': '$ $\\mu$T',
    '$ μH': '$ $\\mu$H',
    '$ μF': '$ $\\mu$F',
  },
};
