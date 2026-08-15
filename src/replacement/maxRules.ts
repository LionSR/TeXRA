// Local imports
import type {
  NonRegexReplacementCategory as NonRegexReplacementCategoryName,
  RegexReplacementCategory as RegexReplacementCategoryName,
} from '@shared/constants/replacementCategories';
import { GREEK_LETTERS } from './constants';
import { NonRegexReplacementCategory, RegexReplacementCategory } from './types';
import {
  createPatterns,
  generateDecoratorShortcuts,
  generateNestedDecoratorShortcuts,
  generateDifferentialSpacing,
  generateCommandShortcuts,
  generateArrowRelationShortcuts,
  generateBackslashFixes,
  generateLegacyTextCommandNormalization,
} from './helpers';

// Greek letter shortcut mappings
const GREEK_LETTER_SHORTCUTS: Record<string, string> = {
  alpha: 'al',
  beta: 'bt',
  gamma: 'ga',
  delta: 'de',
  epsilon: 'eps',
  zeta: 'ze',
  theta: 'ta',
  Theta: 'Ta',
  iota: 'io',
  kappa: 'ka',
  lambda: 'la',
  omicron: 'om',
  sigma: 'sg',
  Sigma: 'Sig',
  upsilon: 'ups',
  phi: 'phi',
  varphi: 'vphi',
  omega: 'om',
  Omega: 'Om',
  Gamma: 'Ga',
};

// Bold Greek destinations must be KaTeX short forms (`\bal`), not `\balpha`.
// `eta` and `Lambda` stay out of GREEK_LETTER_SHORTCUTS: `\et` is undefined
// and `\La` is `\Leftarrow`.
const BOLD_GREEK_SHORTCUTS: Record<string, string> = {
  ...GREEK_LETTER_SHORTCUTS,
  eta: 'et',
  Lambda: 'La',
};

// Automatically generated replacement patterns
const MAX_AUTO_PATTERNS: Record<string, string> = (() => {
  // ====================================================================
  // Backslash and command fixes
  // ====================================================================
  // prettier-ignore
  const backslashFixCommands = [
      // Common custom shortcuts (max-specific only)
      'bet', 'bze', 'cP', 'Om', 'bbf', 'al', 'bt', 'ga', 'de', 'eps', 'ta', 'Ta',
      'ka', 'la', 'sg', 'Sig', 'vphi', 'sha', 'ha', 'Id', 'bzero', 'bone', 'dd',
      'barrho', 'barH', 'barS', 'baral', 'barbv', 'tzero', 'tone', 'tit', 'tif',
      'effH', 'ceffH', 'peq', 'qeq', 'rhoeq', 'rhost', 'nimplies', 'bna', 'bdiv',
      'ddt', 'dddt', 'nn', 'da', 'bksl', 'Ra', 'tauf', 'beps'
    ];

  // ====================================================================
  // Specialized handling for math operators and text commands
  // ====================================================================

  // 1. Math Operators (defined with \DeclareMathOperator*)
  // These require _{\op} and ^{\op} format
  // prettier-ignore
  const mathOperators = [
      'argmin','argmax','tr','Tr','sign','sort','argsort','Cov','Cat','Bern','Unif','ReLU','Concat','Skip','Upsample','Softmax','Conv','BatchNorm','LayerNorm','MaxPool','Dropout','TransformerEncoder','Attention','MultiHead','AdaLN',
    ];

  // 2. Text Commands (defined with \newcommand{\cmd}{{\text{name}}})
  // These allow direct subscript/superscript like P_\cmd
  // prettier-ignore
  const textCommands = ['sys', 'bath', 'tot', 'const', 'discrete', 'decoder', 'encoder', 'pool', 'data', 'mar', 'model', 'prior', 'target', 'full', 'observed', 'accept', 'aux', 'eq', 'st', 'nc', 'irr', 'rev', 'hkp', 'adi', 'nadi', 'exc', 'pos', 'head', 'PE', 'class', 'window', 'Output', 'FFN', 'Strat', 'Ito', 'diss'];

  // prettier-ignore
  const symbolOperators = [
      'infty', 'top',
      'N', 'M',
      '0','1','2',
      'tit', 'wtit', 'tif', 'ttf', 'ttauf', 'tze', 'tzero', 'tone', 'tauf', 'tf', 'ttau', 'tau',
      'bu', 'ta'
    ];

  // ====================================================================
  // Auto-generated differential notation patterns
  // ====================================================================
  // prettier-ignore
  const differentialVariables = ['x', 't', 'tau', 'ttau', 'beta', 'bx', 'bz', 'bze', 'bxi', 'tbx'];
  // prettier-ignore
  const fractionDiffVariables = ['t', 'x', 'tau', 'ttau', 'beta', 'bx', 'bz', 'bze', 'bxi', 'S'];

  // Arrows and Relations
  // Examples: \rightarrow -> \ra, \Leftrightarrow -> \LRa
  const arrowRelationMap = {
    rightarrow: 'ra',
    leftarrow: 'lar',
    leftrightarrow: 'lra',
    Leftarrow: 'La',
    Rightarrow: 'Ra',
    Leftrightarrow: 'LRa',
    Longleftrightarrow: 'LRa',
  };

  // Calculus command shortcuts: \partial -> \der, \nabla -> \na
  const calculusCommandMap = {
    partial: 'der',
    nabla: 'na',
  };

  // Vector Variables: \vec{p} -> \vp, \vec{x} -> \vx
  const vectorLetters = [...'pqvxyz'];

  // Greek Letters (Bold): bold Greek letters with \b prefix
  // prettier-ignore
  const commonGreekSet = new Set(['alpha', 'beta', 'gamma', 'epsilon', 'eta', 'theta', 'mu', 'nu', 'omega', 'phi', 'sigma', 'xi', 'zeta']);
  const commonGreekLetters = GREEK_LETTERS.filter((letter) =>
    commonGreekSet.has(letter),
  );
  // prettier-ignore
  const greekBoldLetters = [...commonGreekLetters, 'chi', 'pi', 'varphi', 'Sigma', 'lambda', 'Gamma', 'Lambda'];

  // Math font letter sets
  const upperLetters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const mathbbLetters = [...'CEINPQRTV'];
  // 'f' stays out of lowerLetters: the MANUAL '\mathbf{f}' -> '\bbf'
  // special case keeps '\bf' (KaTeX's legacy bold switch) out of max-style
  // output.
  const lowerLetters = [...'abcdeghjnpqrsuvwxyz'];
  const mathbfUpperLetters = [...'ABCDEFGIJKMQRUVWXYZ'];
  const alphabetLetters = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  ];

  // Tilde variables
  const tildeLetters = [...'xzpqBFJMPTZ'];
  const tildeLettersMathbf = [...'axpvwz'];
  const tildeLettersMathbfUppercase = [...'MTX'];
  const tildeLettersMathcal = [...'HQSW'];
  const tildeGreekLetters = 'gamma lambda phi psi rho Sigma mu tau'.split(' ');
  const tildeGreekBoldLetters = 'zeta gamma lambda pi xi eta Gamma'.split(' ');

  // Hat variables
  const hatLetters = [...'HFP'];
  const hatGreekLetters = 'sigma Sigma pi rho'.split(' ');
  const hatMathbfLetters = [...'nv'];
  const hatBoldsymbolLetters = ['zeta'];

  // Function names: \F_ -> F_, \G( -> G(
  const functionNames = ['F', 'G'];

  return {
    ...generateBackslashFixes(backslashFixCommands),
    // Math Operators: \mathrm{op} -> \op and \text{op} -> \op
    ...createPatterns(mathOperators, (op) => [
      [`\\mathrm{${op}}`, `\\${op}`],
      [`\\text{${op}}`, `\\${op}`],
      [`\\mbox{${op}}`, `\\${op}`],
      [`\\textrm{${op}}`, `\\${op}`],
      [`{\\rm ${op}}`, `\\${op}`],
      [`_\\op`, `_{\\${op}}`],
      [`^\\op`, `^{\\${op}}`],
    ]),
    // Combined eq/st shortcuts: keep these before the textCommands block so
    // the AUTO \text{eq} -> \eq / \text{st} -> \st rules cannot consume
    // the fragment first (same shadowing class as \mathcal{H}^{\text{eff}}).
    'p^{\\text{eq}}': '\\peq',
    'q^{\\text{eq}}': '\\qeq',
    'p^{\\text{st}}': '\\pst',
    'q^{\\text{st}}': '\\qst',
    '\\rho^{\\text{eq}}': '\\rhoeq',
    '\\rho^{\\text{st}}': '\\rhost',
    // Text Commands: \text{cmd} -> \cmd
    ...createPatterns(textCommands, (cmd) => [
      [`\\text{${cmd}}`, `\\${cmd}`],
      [`\\mathrm{${cmd}}`, `\\${cmd}`],
      [`\\mbox{${cmd}}`, `\\${cmd}`],
      [`\\textrm{${cmd}}`, `\\${cmd}`],
      [`{\\rm ${cmd}}`, `\\${cmd}`],
      [`_{\\${cmd}}`, `_\\${cmd}`],
      [`^{\\${cmd}}`, `^\\${cmd}`],
      [`_{${cmd}}`, `_\\${cmd}`],
      [`^{${cmd}}`, `^\\${cmd}`],
    ]),
    // Symbol operators: _{op} -> _\op (no braces needed)
    ...createPatterns(symbolOperators, (op) => [
      [`_{\\${op}}`, `_\\${op}`],
      [`^{\\${op}}`, `^\\${op}`],
    ]),
    // '\S' is KaTeX's built-in section sign, so the plain-S shortcut lands
    // on the non-conflicting '\sS' destination instead of '_\S'/'^\S'.
    '_{\\S}': '_\\sS',
    '^{\\S}': '^\\sS',
    ...generateDifferentialSpacing(differentialVariables, '~'),
    ...createPatterns(fractionDiffVariables, (variable) => [
      // Handle cases like {dx} -> {\\dd x}
      [`{d${variable}}`, `{\\dd${variable}}`],
      // Handle cases like \\frac{dx} -> \\frac{\\dd x}
      [`\\frac{d${variable}`, `\\frac{\\dd${variable}`],
      // Handle cases like \\frac{d}{dx} -> \\frac{\\dd}{\\dd x}
      [`\\frac{d}{d${variable}}`, `\\frac{\\dd}{\\dd${variable}}`],
    ]),
    '\\int d\\': '\\int \\dd\\',
    '\\int \\dd \\bx \\': '\\int \\dd \\bx~ \\',
    ...generateArrowRelationShortcuts(arrowRelationMap),
    ...generateCommandShortcuts(calculusCommandMap),
    // Vector variables: \vec{x} -> \vx
    ...generateDecoratorShortcuts('vec', vectorLetters, 'v'),
    // Bold Greek: \boldsymbol{\alpha} -> \bal. Keep this before the bare
    // Greek shortcuts below: applyReplacements walks the merged pattern object
    // in insertion order, so the bare-Greek rules would otherwise fire inside
    // \boldsymbol{...} first and shadow these destinations.
    ...createPatterns(greekBoldLetters, (letter) => [
      [
        `\\boldsymbol{\\${letter}}`,
        `\\b${BOLD_GREEK_SHORTCUTS[letter] ?? letter}`,
      ],
    ]),
    ...generateCommandShortcuts(GREEK_LETTER_SHORTCUTS),
    // Combined shortcuts: keep these before the \mathcal, \hat, and effH
    // component rules so the decorated-H combinations are not consumed
    // piecemeal first (AUTO \hat{H} -> \hH would otherwise turn
    // \hat{H}^{\text{eff}} into \hH^{\text{eff}} and the effH rule would
    // then fire inside it, corrupting to \h\effH).
    '\\mathcal{H}^{\\text{eff}}': '\\ceffH',
    '\\cH^{\\text{eff}}': '\\ceffH',
    '\\hat{H}^{\\text{eff}}': '\\hat{\\effH}',
    '\\hH^{\\text{eff}}': '\\hat{\\effH}',
    '\\tilde{\\mathcal{H}}^{\\text{eff}}': '\\tilde{\\ceffH}',
    '\\tcH^{\\text{eff}}': '\\tilde{\\ceffH}',
    '\\bar{H}^{\\text{eff}}': '\\bar{\\effH}',
    '\\barH^{\\text{eff}}': '\\bar{\\effH}',
    // Mathcal: \mathcal{X} -> \cX
    ...generateDecoratorShortcuts('mathcal', upperLetters, 'c'),
    // Mathbb: \mathbb{X} -> \eX
    ...generateDecoratorShortcuts('mathbb', mathbbLetters, 'e'),
    // Mathbf lowercase: \mathbf{x} -> \bx
    ...generateDecoratorShortcuts('mathbf', lowerLetters, 'b'),
    // Mathbf uppercase: \mathbf{X} -> \bX
    ...generateDecoratorShortcuts('mathbf', mathbfUpperLetters, 'b'),
    // Normalize legacy font commands {\rm X}, {\bf X}, {\cal X}
    ...generateLegacyTextCommandNormalization(alphabetLetters, 'mathrm', 'rm'),
    ...generateLegacyTextCommandNormalization(alphabetLetters, 'mathbf', 'bf'),
    ...generateLegacyTextCommandNormalization(
      alphabetLetters,
      'mathcal',
      'cal',
    ),
    // Tilde variables: \tilde{x} -> \tx, \tilde{B} -> \tB
    ...generateDecoratorShortcuts('tilde', tildeLetters, 't'),
    // Tilde with mathbf lowercase: \tilde{\mathbf{x}} -> \tbx
    ...generateNestedDecoratorShortcuts(
      'tilde',
      'mathbf',
      tildeLettersMathbf,
      't',
      'b',
    ),
    // Tilde with mathbf uppercase: \tilde{\mathbf{M}} -> \tbM
    ...generateNestedDecoratorShortcuts(
      'tilde',
      'mathbf',
      tildeLettersMathbfUppercase,
      't',
      'b',
    ),
    // Tilde with mathcal: \tilde{\mathcal{H}} -> \tcH
    ...generateNestedDecoratorShortcuts(
      'tilde',
      'mathcal',
      tildeLettersMathcal,
      't',
      'c',
    ),
    // Tilde with Greek: \tilde{\gamma} -> \tga
    ...createPatterns(tildeGreekLetters, (letter) => [
      [
        `\\tilde{\\${letter}}`,
        `\\t${GREEK_LETTER_SHORTCUTS[letter] ?? letter}`,
      ],
    ]),
    // Tilde with boldsymbol+Greek: \tilde{\boldsymbol{\zeta}} -> \tbze
    ...createPatterns(tildeGreekBoldLetters, (letter) => [
      [
        `\\tilde{\\boldsymbol{\\${letter}}}`,
        `\\tb${GREEK_LETTER_SHORTCUTS[letter] ?? letter}`,
      ],
    ]),
    // Hat variables: \hat{H} -> \hH
    ...generateDecoratorShortcuts('hat', hatLetters, 'h'),
    // Hat with Greek: \hat{\sigma} -> \hsg
    ...createPatterns(hatGreekLetters, (letter) => [
      [`\\hat{\\${letter}}`, `\\h${GREEK_LETTER_SHORTCUTS[letter] ?? letter}`],
    ]),
    // Hat with mathbf: \hat{\mathbf{n}} -> \hbn
    ...generateNestedDecoratorShortcuts(
      'hat',
      'mathbf',
      hatMathbfLetters,
      'h',
      'b',
    ),
    // Hat with boldsymbol+Greek: \hat{\boldsymbol{\zeta}} -> \hbze
    ...createPatterns(hatBoldsymbolLetters, (letter) => [
      [
        `\\hat{\\boldsymbol{\\${letter}}}`,
        `\\hb${GREEK_LETTER_SHORTCUTS[letter] ?? letter}`,
      ],
    ]),
    // Bold backslash fixes: \\ba -> \ba (lowercase), \\bA -> \bA (uppercase)
    ...generateBackslashFixes(
      [...lowerLetters, ...mathbfUpperLetters].map((letter) => `b${letter}`),
    ),
    ...createPatterns(functionNames, (name) => [
      [`\\${name}_`, `${name}_`],
      [`\\${name}^`, `${name}^`],
      [`\\${name}(`, `${name}(`],
    ]),
  };
})();

// Manually specified replacement patterns
const MAX_MANUAL_PATTERNS: Record<string, string> = {
  // equation labels:
  '\\label{eq:': '\\label{eqn:',

  // Subscript/superscript formatting
  '_{tot}': '_{\\tot}',
  '^{tot}': '^{\\tot}',
  '^\\intercal': '^\\top',
  '^{\\intercal}': '^\\top',

  // Common Math Shortcuts
  '\\frac{1}{2}\\': '\\ha\\',
  '\\frac{1}{2} ': '\\ha ',
  '\\frac12': '\\ha',
  '\\frac{1}{\\sqrt{2}}\\': '\\sha\\',
  '\\frac{1}{\\sqrt{2}} ': '\\sha ',
  // For the special case \frac{1}{2}a -> \haa which is wrong
  '\\mathds{1}': '\\Id',
  '\\boldsymbol{0}': '\\bzero',
  '\\boldsymbol{1}': '\\bone',
  '\\mathrm{d}': '\\dd',

  // Fix specific cases
  '\\boldsymbol{\\Sigma}': '\\bSig',
  '\\bSigma': '\\bSig',

  // Special case for 'f' which uses 'bbf' instead of 'bf'
  '\\mathbf{f}': '\\bbf',

  // Bar Variables
  '\\bar{\\rho}': '\\barrho',
  '\\bar{H}': '\\barH',
  '\\bar{S}': '\\barS',
  '\\bar{\\alpha}': '\\baral',
  '\\bar{\\mathbf{v}}': '\\barbv',

  // Special tilde cases - constants
  '\\tilde{0}': '\\tzero',
  '\\tilde{1}': '\\tone',
  '\\tilde{t}': '\\tit',
  '\\tilde{f}': '\\tif',

  // Physics and Statistical Mechanics
  'H^{\\text{eff}}': '\\effH',
  'p^{\\text{ss}}': '\\pst',
  'q^{\\text{ss}}': '\\qst',

  // Special cases that don't fit the auto-generated patterns
  '\\not\\implies': '\\nimplies',
  '\\boldsymbol{\\nabla}': '\\bna',
  '\\text{div}': '\\bdiv',
  '\\frac{\\partial}{\\partial t}': '\\ddt',
  '\\frac{\\mathrm{d}}{\\mathrm{d} t}': '\\dddt',

  // Miscellaneous
  '\\nonumber': '\\nn',
  '\\dagger': '\\da',
  '\\backslash': '\\bksl',

  // Arrow spacing
  '\\quad\\Ra': '~~~\\Ra',
  '    &\\quad ': '    &~~~ ',
  '\\Ra\,': '\\Ra~',

  '{\\ddt}': '{\\dd t}',
  '\\int_0^\\tauf dt': '\\int_0^{\\tauf} \\ddt',

  // Other replacements
  '\\tau_f': '\\tauf',

  // Equilibrium and steady state notation
  // Subscript rho eq/st stay manual: the AUTO \text{eq}/\text{st} rules
  // consume the fragment first (preserving \rho_\eq / \rho_\st), so
  // these entries are inert for bare sources but document the intended
  // compaction destinations.
  '\\rho_{\\text{eq}}': '\\rhoeq',
  '\\rho_{\\text{st}}': '\\rhost',
  '\\rho^{\\text{ss}}': '\\rhost',
  '\\rho^{\\text{sst}}': '\\rhost',
  '\\rho_{\\text{ss}}': '\\rhost',
  '\\rho_{\\text{sst}}': '\\rhost',
  '{\\text{ss}}': '{\\text{st}}',
  '{\\text{sst}}': '{\\text{st}}',
  '\\rho^{st}': '\\rhost',
  '\\rho^{eq}': '\\rhoeq',
  '\\rho^{\\eq}': '\\rhoeq',
  '\\rho^{\\st}': '\\rhoeq',
  '\\rho^{ss}': '\\rhost',
  '\\rho_{ss}': '\\rhost',
  '\\ln': '\\log',
  '\\rhost^R': '\\rhost_R',
  '\\bepsilon': '\\beps',
  '_{ex}': '_\\exc',
  '^{ex}': '^{\\exc}',
  '_{hk}': '_\\hkp',
  '^{hk}': '^{\\hkp}',
  '_{na}': '_\\nadi',
  '^{na}': '^{\\nadi}',

  // cleveref notation:
  '\\cref{ch:': 'Chapter~\\ref{ch:',
  '\\crefs': '\\cref',
  '  \\cref': ' \\cref',
  '  \\ref': ' \\ref',
  '\\eqref{eqn:': '\\cref{eqn:',

  '\\log\\': '\\log \\',

  // '\\mathbf{I}': '\\bI',

  // Specialized replacements
  '+ O(': '+ \\cO(',

  // However, use a hyphen when closing up the word might lead to confusion, where the closed-up word would be cumbersome, or where the second element begins with a capital letter or number, e.g. un-ionized, pre-loss, pseudo-objectivity, sub-Gaussian.
  unionized: 'uni-ionized',
  preloss: 'pre-loss',
  subgaussian: 'sub-gaussian',
  nongaussian: 'non-gaussian',
  nonGaussian: 'non-Gaussian',
  pseudoobjectivity: 'pseudo-objectivity',
  nonnegati: 'non-negati',
  antiIto: 'anti-Ito',
};

export const MAX_STYLE_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'max_style' satisfies NonRegexReplacementCategoryName,
  description: 'Maximum style replacements for LaTeX commands and symbols',
  isRegex: false,
  patterns: { ...MAX_AUTO_PATTERNS, ...MAX_MANUAL_PATTERNS },
};

// prettier-ignore
// Define the comprehensive list of all trigger words
const FULL_WORDS = [
  'apply', 'Apply', 'applies', 'Applies', 'applying', 'Applying', 'base', 'Base', 'based', 'Based', 'bases', 'Bases', 'basing', 'Basing', 'but', 'But', 'by', 'By', 
  'between', 'Between', 'betweening', 'Betweening', 'betweened', 'Betweened', 'betweenes', 'Betweenes',
  'compare', 'Compare', 'compares', 'Compares', 'comparing', 'Comparing', 'condition', 'Condition', 'conditions', 'Conditions', 
  'define', 'Define', 'defines', 'Defines', 'defining', 'Defining', 'definition', 'Definition', 'definitions', 'Definitions', 
  'derive', 'Derive', 'derived', 'Derived', 'derives', 'Derives', 'deriving', 'Deriving', 
  'differentiate', 'Differentiate', 'differentiates', 'Differentiates', 'differentiating', 'Differentiating', 
  // 'equation', 'Equation', 'equations', 'Equations', // Special word
  'express', 'Express', 'expresses', 'Expresses', 'expressing', 'Expressing', 'execute', 'Execute', 'executes', 'Executes', 'executing', 'Executing',
  'Finally', 
  'follow', 'Follow', 'follows', 'Follows', 'following', 'Following', 'for', 'For', 
  'be',
  'formula', 'Formula', 'formulas', 'Formulas', // Special word
  'from', 'From', 
  'give', 'Give', 'given', 'Given', 'gives', 'Gives', 'giving', 'Giving', 
  'hold', 'Hold', 'holds', 'Holds', 'holding', 'Holding', 'if', 'If', 'in', 'In', 
  'integrate', 'Integrate', 'integrates', 'Integrates', 'integrating', 'Integrating', 'into', 'Into', 
  'know', 'Know', 'knowing', 'Knowing', 'known', 'Known', 'knows', 'Knows', 'like', 'Like', 
  'limit', 'Limit', 'limits', 'Limits', 'now', 'Now', 'of', 'Of', 
  'probability', 'Probability', 'probabilities', 'Probabilities', 
  'rearrange', 'Rearrange', 'rearranged', 'Rearranged', 'rearranges', 'Rearranges', 'rearranging', 'Rearranging', 
  'rewrite', 'Rewrite', 'rewrites', 'Rewrites', 'rewriting', 'Rewriting', 
  'run', 'Run', 'running', 'Running', 'runs', 'Runs', 
  // 'SDE', 'SDEs', // Special word
  'satisfy', 'Satisfy', 'satisfies', 'Satisfies', 'satisfying', 'Satisfying', 
  'see', 'See', 'seeing', 'Seeing', 'sees', 'Sees', 
  'show', 'Show', 'shown', 'Shown', 'shows', 'Shows', 'showing', 'Showing', 
  'solve', 'Solve', 'solves', 'Solves', 'solving', 'Solving', 
  'state', 'State', 'states', 'States', 'stating', 'Stating', 
  'substitute', 'Substitute', 'substitutes', 'Substitutes', 'substituting', 'Substituting', 
  'that', 'That', 'Then', 
  // 'theorem', 'Theorem', 'theorems', 'Theorems', 
  'to', 'To', 'under', 'Under', 
  'use', 'Use', 'uses', 'Uses', 'using', 'Using', 'used', 'Used',
  'particular',
  'vector', 'Vector', 'vectors', 'Vectors', 'where', 'Where', 'While', 'while', 'with', 'With',
  'transform', 'Transform', 'transforms', 'Transforms', 'transforming', 'Transforming',
];

// Define the "special" words that don't get 'eqn.~' prefix
// prettier-ignore
const SPECIAL_WORDS = [
  'equation',
  'Equation',
  'equations',
  'Equations',
  'SDE',
  'SDEs',
  'formula',
  'Formula',
  'formulas',
  'Formulas',
  'recipe',
  'Recipe',
  'recipes',
  'Recipes',
  'problem',
  'Problem',
  'problems',
  'Problems',
  'solution',
  'Solution',
  'solutions',
  'equality',
  'Equality',
  'equalities',
  'Equalities',
  'inequality',
  'Inequality',
  'inequalities',
  'process',
  'Process',
  'processes',
  'Processes',
  'procedure',
  'Procedure',
  'procedures',
];

// Define "general" words (full list minus special words)
const GENERAL_WORDS = FULL_WORDS.filter(
  (word) => !SPECIAL_WORDS.includes(word),
);

/**
 * Regex matching one of `words`, an optional comma, and a reference pattern.
 */
function wordsBefore(words: string[], reference: string): string {
  return `(${words.join('|')})(?:,)?\\s+${reference}`;
}

const CREF_EQN = '\\\\cref\\{(eqn:[^,}]+)\\}';
const EQREF_EQN = '\\\\eqref\\{(eqn:[^,}]+)\\}';
const PAREN_CREF_EQN = `\\(${CREF_EQN}\\)`;
const PAREN_EQREF_EQN = `\\(${EQREF_EQN}\\)`;
const CREF_FIG = '\\\\cref\\{(fig:[^,}]+)\\}';

/**
 * Legacy unbraced `_\S`/`^\S` plain-S shortcut migration.
 *
 * Introduced 2026-08-15 (#10507) to migrate persisted pre-#10439
 * `symbolOperators` output, which used the unbraced S destination before the
 * plain-S shortcut was renamed to `\sS`. Retire after 2026-11-15, three
 * months after the replacement shipped; delete the MAX_REGEX spread below,
 * the max-style-gated engine call in `applyAll`, and the drift assertions
 * together.
 *
 * The negative lookbehind keeps escaped script markers (`\_\S`, `\^\S`)
 * intact, and the right-side boundary keeps S-prefixed commands such as
 * `\Strat`/`\Sig` intact. A `\S` followed by a digit remains ambiguous —
 * legacy `\S0` migration versus a genuine `^\S2` — and is still migrated.
 */
export const LEGACY_UNBRACED_S_MIGRATION: RegexReplacementCategory = {
  name: 'legacy_unbraced_s_migration',
  description:
    'Legacy unbraced plain-S shortcut migration for persisted pre-rename output',
  isRegex: true,
  flags: 'gms',
  patterns: {
    '(?<!\\\\)([_^])\\\\S(?![A-Za-z])': '$1\\sS',
  },
};

/**
 * Convert the KaTeX-only `\sS` plain-S destination back to LaTeX's built-in
 * `\S` section sign when writing `.tex` files. `\sS` is defined only by the
 * progress-view KaTeX macro table; project documents compile against the
 * user's own preamble, where `\sS` is undefined. `\S` compiles everywhere.
 *
 * Boundary-aware for the same reason as the migration rule: a literal
 * `_\sS` prefix replacement would corrupt `_\sStrat`-style commands.
 */
export function restoreLatexSectionSign(text: string): string {
  return text.replaceAll(/([_^])\\sS(?![A-Za-z])/g, '$1\\S');
}

export const MAX_REGEX_REPLACEMENTS: RegexReplacementCategory = {
  name: 'max_style_regex' satisfies RegexReplacementCategoryName,
  description:
    'Maximum style regex replacements for LaTeX commands and symbols',
  isRegex: true,
  flags: 'gms',
  patterns: {
    // Subscript/superscript formatting

    // MATHEMATICS STYLE
    // Functions defined with domain/range should use \colon
    // '([a-zA-Z]\\s*):([^:]+)\\\\to\\s*([A-Za-z])': '$1\\colon$2\\to $3',
    // Functions defined with domain/range should use \colon (improved version)
    // '(\\$[^$]*[a-zA-Z][a-zA-Z0-9]*(?:\\([^)]*\\))?\\s*):(?!:)(\\s*[^:$]+?\\\\to)':
    // '$1\\colon$2',
    // Not working, maybe we should limit the length
    // This is too dangerous

    // // Ellipses should be raised between operators but not between punctuation
    // '([+\\-*\\/])\\s*\\.\\.\\.\\s*([+\\-*\\/])': '$1\\cdots$2',
    // '([,;])\\s*\\.\\.\\.\\s*([,;])': '$1\\ldots$2',
    // Max like ,..,

    // Legacy unbraced '\S' plain-S shortcut migration: introduced
    // 2026-08-15 (#10507), retire after 2026-11-15 (three months after the
    // replacement shipped). See LEGACY_UNBRACED_S_MIGRATION for the
    // boundary-aware details and remaining digit ambiguity.
    ...LEGACY_UNBRACED_S_MIGRATION.patterns,

    // PUNCTUATION AND SPACING

    // Spell words with the following preﬁxes solid and not hyphenated: anti, co, counter, extra, inter, intra, macro, micro, multi, non, over, post, pre, pro, pseudo, psycho, re, semi, socio, sub, trans.
    '\\b(anti|co|counter|extra|inter|intra|macro|micro|multi|non|over|post|pre|pro|pseudo|psycho|re|semi|socio|sub|trans)-([a-z]+)':
      '$1$2',

    // GROUP 1: PARENTHESIZED REFERENCES
    // Single equation in parentheses (\cref{eqn:...})
    '\\(\\\\cref\\{(eqn:[^,}]+)\\}\\)': '(eqn.~\\ref{$1})',

    // --- Custom word list based \cref{eqn:...} replacements ---
    // Special words (equation, SDE, formula) before non-parenthesized \cref{eqn:...}
    [wordsBefore(SPECIAL_WORDS, CREF_EQN)]: '$1~\\ref{$2}',

    // General words before non-parenthesized \cref{eqn:...}
    [wordsBefore(GENERAL_WORDS, CREF_EQN)]: '$1 eqn.~\\ref{$2}',

    // General
    [wordsBefore(GENERAL_WORDS, EQREF_EQN)]: '$1 eqn.~\\ref{$2}',

    // Special pattern for "and \cref"
    'and\\s+\\\\cref\\{(eqn:[^,}]+)\\}': 'and eqn.~\\ref{$1}',

    // Special words (equation, SDE, formula) before parenthesized \cref{eqn:...}
    [wordsBefore(SPECIAL_WORDS, PAREN_CREF_EQN)]: '$1~(\\ref{$2})',

    // General words before parenthesized \cref{eqn:...}
    [wordsBefore(GENERAL_WORDS, PAREN_CREF_EQN)]: '$1 eqn.~(\\ref{$2})',

    // General words before \eqref{eqn:...}
    [wordsBefore(GENERAL_WORDS, PAREN_EQREF_EQN)]: '$1 eqn.~\\ref{$2}',

    // --- End of custom word list based \cref{eqn:...} replacements ---

    // Capitalized Cref version
    '\\\\Cref\\{(eqn:[^,}]+)\\}': 'Eqn.~\\ref{$1}',

    // General case for \cref{eqn:...} not covered by specific preceding words or parentheses
    // '\\\\cref\\{(eqn:[^,}]+)\\}': 'eqn.~\\ref{$1}',

    // PARENTHESIZED REFERENCES
    // Single figure in parentheses (\cref{fig:...})
    '\\(\\\\cref\\{(fig:[^,}]+)\\}\\)': '(Figure~\\ref{$1})',

    // --- Custom word list based \cref{fig:...} replacements ---
    // Common phrases (full word list) followed by \cref{fig:...}
    [wordsBefore(FULL_WORDS, CREF_FIG)]: '$1 Figure~\\ref{$2}',
    // --- End of custom word list based \cref{fig:...} replacements ---

    '\\(see\\s+\\\\cref\\{(fig:[^,}]+)\\}\\)': '(see Figure~\\ref{$1})',

    // General case for \cref{fig:...} not covered by specific preceding words or parentheses
    // '\\\\cref\\{(fig:[^,}]+)\\}': 'Figure~\\ref{$1}',
    // General case for \Cref{fig:...}
    // '\\\\Cref\\{(fig:[^,}]+)\\}': 'Figure~\\ref{$1}',

    // Next step
    // \KL[|] -> \\KL[\|]
    // get _ or - in the equation labels consistent.
  },
};
