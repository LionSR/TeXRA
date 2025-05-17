import { ReplacementCategory } from './replacementTypes';
import {
  generateMathCommandShortcuts,
  generateDecoratedMathShortcuts,
  generateMathFontShortcuts,
  generateBoldBackslashFixes,
  generateDecoratorShortcuts,
  generateNestedDecoratorShortcuts,
  generateVectorShortcuts,
  generateDifferentialSpacing,
  generateCommandShortcuts,
  generateArrowRelationShortcuts,
  generateBackslashFixes,
  GREEK_LETTERS,
} from './replacementHelpers';

// Greek letter shortcut mappings
export const GREEK_LETTER_SHORTCUTS: { [key: string]: string } = {
  alpha: 'al',
  beta: 'bt',
  gamma: 'ga',
  delta: 'de',
  epsilon: 'eps',
  varepsilon: 'varepsilon',
  zeta: 'ze',
  eta: 'eta',
  theta: 'ta',
  Theta: 'Ta',
  iota: 'io',
  kappa: 'ka',
  lambda: 'la',
  mu: 'mu',
  nu: 'nu',
  xi: 'xi',
  omicron: 'om',
  pi: 'pi',
  rho: 'rho',
  sigma: 'sg',
  Sigma: 'Sig',
  tau: 'tau',
  upsilon: 'ups',
  phi: 'phi',
  varphi: 'vphi',
  chi: 'chi',
  psi: 'psi',
  omega: 'om',
  Omega: 'Om',
  Gamma: 'Ga',
  Lambda: 'Lambda',
  Delta: 'Delta',
};

// Automatically generated replacement patterns
export const MAX_AUTO_REPLACEMENTS: ReplacementCategory = {
  name: 'max_auto',
  description: 'Automatically generated maximum style replacements for LaTeX',
  isRegex: false,
  patterns: (() => {
    // Initialize patterns object
    const patterns: { [key: string]: string } = {};

    // ====================================================================
    // Backslash and command fixes
    // ====================================================================

    // Fix for double backslashes in various commands
    // Examples: \\alpha -> \alpha, \\mathbf -> \mathbf

    // Math Operators, Greek Letters, Symbols, and common commands
    // prettier-ignore
    const backslashFixCommands = [
      // Common custom shortcuts (max-specific only)
      'bet', 'bze', 'cP', 'Om', 'bbf', 'al', 'bt', 'ga', 'de', 'eps', 'ta', 'Ta',
      'ka', 'la', 'sg', 'Sig', 'vphi', 'sha', 'ha', 'Id', 'bzero', 'bone', 'dd',
      'barrho', 'barH', 'barS', 'baral', 'barbv', 'tzero', 'tone', 'tit', 'tif',
      'effH', 'ceffH', 'peq', 'qeq', 'rhoeq', 'rhost', 'nimplies', 'bna', 'bdiv',
      'ddt', 'dddt', 'nn', 'da', 'bksl', 'Ra', 'tauf', 'beps'
    ];

    // Generate backslash fixes for all the above commands
    Object.assign(patterns, generateBackslashFixes(backslashFixCommands));

    // ====================================================================
    // Specialized handling for math operators and text commands
    // ====================================================================

    // 1. Math Operators (defined with \DeclareMathOperator*)
    // These require _{\op} and ^{\op} format
    // prettier-ignore
    const mathOperators = [
      'argmin','argmax','tr','Tr','sign','sort','argsort','Cov','Cat','Bern','Unif','ReLU','Concat','Skip','Upsample','Softmax','Conv','BatchNorm','LayerNorm','MaxPool','Dropout','TransformerEncoder','Attention','MultiHead','AdaLN',
      'sort','argsort','Cov','Cat','Bern','Unif','ReLU','Concat','Skip','Upsample','Softmax','Conv','BatchNorm','LayerNorm','MaxPool','Dropout','TransformerEncoder','Attention','MultiHead','AdaLN',
    ];

    // Direct mapping: \mathrm{op} -> \op and \text{op} -> \op
    mathOperators.forEach((op) => {
      // Common variants
      patterns[`\\mathrm{${op}}`] = `\\${op}`;
      patterns[`\\text{${op}}`] = `\\${op}`;
      patterns[`\\mbox{${op}}`] = `\\${op}`;
      patterns[`\\textrm{${op}}`] = `\\${op}`;
      patterns[`{\\rm ${op}}`] = `\\${op}`;
      patterns[`_\\op`] = `_{\\${op}}`;
      patterns[`^\\op`] = `^{\\${op}}`;
    });

    // 2. Text Commands (defined with \newcommand{\cmd}{{\text{name}}})
    // These allow direct subscript/superscript like P_\cmd
    // prettier-ignore
    const textCommands = ['sys', 'bath', 'tot', 'const', 'discrete', 'decoder', 'encoder', 'pool', 'data', 'mar', 'model', 'prior', 'target', 'full', 'observed', 'accept', 'aux', 'eq', 'st', 'nc', 'irr', 'rev', 'hkp', 'adi', 'nadi', 'exc', 'pos', 'head', 'PE', 'class', 'window', 'Output', 'FFN', 'Strat', 'Ito', 'diss'];

    // Direct mapping: \text{cmd} -> \cmd
    textCommands.forEach((cmd) => {
      // Common variants
      patterns[`\\text{${cmd}}`] = `\\${cmd}`;
      patterns[`\\mathrm{${cmd}}`] = `\\${cmd}`;
      patterns[`\\mbox{${cmd}}`] = `\\${cmd}`;
      patterns[`\\textrm{${cmd}}`] = `\\${cmd}`;
      patterns[`{\\rm ${cmd}}`] = `\\${cmd}`;
      patterns[`_{\\${cmd}}`] = `_\\${cmd}`;
      patterns[`^{\\${cmd}}`] = `^\\${cmd}`;
      patterns[`_{${cmd}}`] = `_\\${cmd}`;
      patterns[`^{${cmd}}`] = `^\\${cmd}`;
    });

    // prettier-ignore
    const symbolOperators = [
      'infty', 'top',
      'N', 'M', 'S',
      '0','1','2',
      'tit', 'wtit', 'tif', 'ttf', 'ttauf', 'tze', 'tzero', 'tone', 'tauf', 'tf', 'ttau', 'tau', 'ttf',
      'bu', 'ta'
    ];
    // these variables might occur as lower indices, but they do not need {..}
    symbolOperators.forEach((op) => {
      patterns[`_{\\${op}}`] = `_\\${op}`;
      patterns[`^{\\${op}}`] = `^\\${op}`;
    });

    // ====================================================================
    // Auto-generated differential notation patterns
    // ====================================================================

    // Variables that need differential spacing
    // prettier-ignore
    const differentialVariables = ['x', 't', 'tau', 'ttau', 'beta', 'bx', 'bz', 'bze', 'bxi', 'tbx'];

    // Generate differential spacing patterns
    const differentialSpacingPatterns = generateDifferentialSpacing(
      differentialVariables,
      '~',
    );
    Object.assign(patterns, differentialSpacingPatterns);

    // Variables that need differential replacement in fractions and integrals
    // prettier-ignore
    const fractionDiffVariables = ['t', 'x', 'tau', 'ttau', 'beta', 'bx', 'bz', 'bze', 'bxi', 'S'];

    // Generate patterns for each variable
    fractionDiffVariables.forEach((variable) => {
      // Handle cases like {dx} -> {\\dd x}
      patterns[`{d${variable}}`] = `{\\dd${variable}}`;

      // Handle cases like \\frac{dx} -> \\frac{\\dd x}
      patterns[`\\frac{d${variable}`] = `\\frac{\\dd${variable}`;

      // Handle cases like \\frac{d}{dx} -> \\frac{\\dd}{\\dd x}
      patterns[`\\frac{d}{d${variable}}`] = `\\frac{\\dd}{\\dd${variable}}`;
    });

    // Integration patterns
    patterns['\\int d\\'] = '\\int \\dd\\';
    patterns['\\int \\dd \\bx \\'] = '\\int \\dd \\bx~ \\';

    // Keep the generateTextCommandNormalization utility for other cases where needed

    // Arrows and Relations
    // Examples: \rightarrow -> \ra, \Leftrightarrow -> \LRa
    const arrowRelationMap = {
      rightarrow: 'ra',
      leftarrow: 'lar',
      leftrightarrow: 'lra',
      Leftarrow: 'La',
      Rightarrow: 'Ra',
      Leftrightarrow: 'LRa',
    };
    Object.assign(patterns, generateArrowRelationShortcuts(arrowRelationMap));

    // Calculus command shortcuts
    // Examples: \partial -> \der, \nabla -> \na
    const calculusCommandMap = {
      partial: 'der',
      nabla: 'na',
    };
    Object.assign(patterns, generateCommandShortcuts(calculusCommandMap));

    // Vector Variables
    // Examples:
    // \vec{p} -> \vp (momentum vector)
    // \vec{x} -> \vx (position vector)
    const vectorLetters = 'pqvxyz'.split('');
    Object.assign(patterns, generateVectorShortcuts(vectorLetters));

    // Greek Letters (Regular)
    // Map full Greek letter names to shorter versions
    // Examples:
    // \alpha -> \al
    // \theta -> \ta

    // Make a copy of GREEK_LETTER_SHORTCUTS and remove Delta to avoid shortening it
    const greekShortcuts = { ...GREEK_LETTER_SHORTCUTS };
    delete greekShortcuts['Delta']; // Prevent Delta from being shortened to De

    Object.assign(patterns, generateMathCommandShortcuts(greekShortcuts));

    // Greek Letters (Bold)
    // Generate patterns for bold Greek letters with \b prefix
    // prettier-ignore
    const commonGreekLetters = GREEK_LETTERS.filter((letter) => ['alpha', 'beta', 'gamma', 'epsilon', 'eta', 'theta', 'mu', 'nu', 'omega', 'phi', 'sigma', 'xi', 'zeta'].includes(letter));

    // prettier-ignore
    const greekBoldLetters = [...commonGreekLetters, 'chi', 'pi', 'varphi', 'Sigma', 'lambda', 'Gamma', 'Lambda'];
    Object.assign(
      patterns,
      generateDecoratedMathShortcuts(['boldsymbol'], greekBoldLetters, 'b'),
    );

    // Mathcal Letters
    // Map \mathcal{X} to shorter \cX versions for all uppercase letters
    const upperLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    Object.assign(
      patterns,
      generateMathFontShortcuts(upperLetters, 'mathcal', 'c'),
    );

    // Mathbb Letters
    // Map \mathbb{X} to shorter \eX versions for specific letters
    const mathbbLetters = 'CEINPQRTV'.split('');
    Object.assign(
      patterns,
      generateMathFontShortcuts(mathbbLetters, 'mathbb', 'e'),
    );

    // Mathbf Letters (Lowercase)
    // Map \mathbf{x} to shorter \bx versions
    const lowerLetters = 'abcdefghjnpqrsuvwxyz'.split('');
    Object.assign(
      patterns,
      generateMathFontShortcuts(lowerLetters, 'mathbf', 'b'),
    );

    // Mathbf Letters (Uppercase)
    // Map \mathbf{X} to shorter \bX versions for uppercase letters
    const mathbfUpperLetters = 'ABCDEFGIJKMQRUVWXYZ'.split('');
    Object.assign(
      patterns,
      generateMathFontShortcuts(mathbfUpperLetters, 'mathbf', 'b'),
    );

    // Tilde variables - simple letters
    // Examples: \tilde{x} -> \tx, \tilde{B} -> \tB
    const tildeLetters = 'xzpqBFJMPTZ'.split('');
    Object.assign(
      patterns,
      generateDecoratorShortcuts('tilde', tildeLetters, 't'),
    );

    // Tilde with mathbf - lowercase
    // Example: \tilde{\mathbf{x}} -> \tbx
    const tildeLettersMathbf = 'axpvwz'.split('');
    Object.assign(
      patterns,
      generateNestedDecoratorShortcuts(
        'tilde',
        'mathbf',
        tildeLettersMathbf,
        't',
        'b',
      ),
    );

    // Tilde with mathbf - uppercase
    // Example: \tilde{\mathbf{M}} -> \tbM
    const tildeLettersMathbfUppercase = 'MTX'.split('');
    Object.assign(
      patterns,
      generateNestedDecoratorShortcuts(
        'tilde',
        'mathbf',
        tildeLettersMathbfUppercase,
        't',
        'b',
      ),
    );

    // Tilde with mathcal - uppercase
    // Example: \tilde{\mathcal{H}} -> \tcH
    const tildeLettersMathcal = 'HQSW'.split('');
    Object.assign(
      patterns,
      generateNestedDecoratorShortcuts(
        'tilde',
        'mathcal',
        tildeLettersMathcal,
        't',
        'c',
      ),
    );

    // Tilde with Greek letters
    // Example: \tilde{\gamma} -> \tga
    const tildeGreekLetters = 'gamma lambda phi psi rho Sigma mu tau'.split(
      ' ',
    );
    tildeGreekLetters.forEach((letter) => {
      const shortcut = GREEK_LETTER_SHORTCUTS[letter] || letter;
      patterns[`\\tilde{\\${letter}}`] = `\\t${shortcut}`;
    });

    // Tilde with boldsymbol+Greek
    // Example: \tilde{\boldsymbol{\zeta}} -> \tbze
    const tildeGreekBoldLetters = 'zeta gamma lambda pi xi eta Gamma'.split(
      ' ',
    );
    tildeGreekBoldLetters.forEach((letter) => {
      const shortcut = GREEK_LETTER_SHORTCUTS[letter] || letter;
      patterns[`\\tilde{\\boldsymbol{\\${letter}}}`] = `\\tb${shortcut}`;
    });

    // Hat variables
    // Example: \hat{H} -> \hH
    const hatLetters = 'HFP'.split('');
    Object.assign(patterns, generateDecoratorShortcuts('hat', hatLetters, 'h'));

    // Hat with Greek letters
    // Example: \hat{\sigma} -> \hsg
    const hatGreekLetters = 'sigma Sigma pi rho'.split(' ');
    hatGreekLetters.forEach((letter) => {
      const shortcut = GREEK_LETTER_SHORTCUTS[letter] || letter;
      patterns[`\\hat{\\${letter}}`] = `\\h${shortcut}`;
    });

    // Hat with mathbf
    // Example: \hat{\mathbf{n}} -> \hbn
    const hatMathbfLetters = 'nv'.split('');
    Object.assign(
      patterns,
      generateNestedDecoratorShortcuts(
        'hat',
        'mathbf',
        hatMathbfLetters,
        'h',
        'b',
      ),
    );

    // Hat with boldsymbol+Greek
    // Example: \hat{\boldsymbol{\zeta}} -> \hbze
    const hatBoldsymbolLetters = 'zeta'.split(' ');
    hatBoldsymbolLetters.forEach((letter) => {
      const shortcut = GREEK_LETTER_SHORTCUTS[letter] || letter;
      patterns[`\\hat{\\boldsymbol{\\${letter}}}`] = `\\hb${shortcut}`;
    });

    // Fix for extra backslashes in bold symbols
    // Automatically generate fixes for lowercase bold letters (e.g., \\ba -> \ba)
    Object.assign(patterns, generateBoldBackslashFixes('b', lowerLetters));

    // Automatically generate fixes for uppercase bold letters (e.g., \\bA -> \bA)
    Object.assign(
      patterns,
      generateBoldBackslashFixes('b', mathbfUpperLetters),
    );

    // Fix for double backslashes in custom commands
    // Examples: \\bet -> \bet, \\bbf -> \bbf
    const customShortcutFixes = ['bet', 'bze', 'cP', 'Om', 'bbf'];
    customShortcutFixes.forEach((shortcut) => {
      patterns[`\\\\${shortcut}`] = `\\${shortcut}`;
    });

    // Convert functions to simpler forms (e.g., F_/G_)
    // Examples: \F_ -> F_, \G( -> G(
    const functionNames = ['F', 'G'];
    functionNames.forEach((name) => {
      patterns[`\\${name}_`] = `${name}_`;
      patterns[`\\${name}^`] = `${name}^`;
      patterns[`\\${name}(`] = `${name}(`;
    });

    return patterns;
  })(),
};

// Manually specified replacement patterns
export const MAX_MANUAL_REPLACEMENTS: ReplacementCategory = {
  name: 'max_manual',
  description: 'Manually specified maximum style replacements for LaTeX',
  isRegex: false,
  patterns: {
    // Subscript/superscript formatting
    '_{tot}': '_{\\tot}',
    '^{tot}': '^{\\tot}',
    '^\\intercal': '^\\top',
    '^{\\intercal}': '^\\top',

    // Common Math Shortcuts
    '\\frac{1}{2}': '\\ha',
    '\\frac{1}{\\sqrt{2}}': '\\sha',
    '\\mathds{1}': '\\Id',
    '\\boldsymbol{0}': '\\bzero',
    '\\boldsymbol{1}': '\\bone',
    '\\mathrm{d}': '\\dd',

    // Fix specific cases
    '\\boldsymbol{\\Sigma}': '\\bSig',
    '\\bSigma': '\\bSig',

    '\\frac12': '\\ha',

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
    '\\mathcal{H}^{\\text{eff}}': '\\ceffH',
    'p^{\\text{eq}}': '\\peq',
    'q^{\\text{eq}}': '\\qeq',
    'p^{\\text{st}}': '\\pst',
    'q^{\\text{st}}': '\\qst',
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

    //
    '{\\ddt}': '{\\dd t}',
    '\\int_0^\\tauf dt': '\\int_0^{\\tauf} \\ddt',

    // Other replacements
    '\\tau_f': '\\tauf',

    // Equilibrium and steady state notation
    '\\rho^{\\text{eq}}': '\\rhoeq',
    '\\rho^{\\text{st}}': '\\rhost',
    '\\rho^{\\text{ss}}': '\\rhost',
    '\\rho^{\\text{sst}}': '\\rhost',
    '\\rho_{\\text{eq}}': '\\rhoeq',
    '\\rho_{\\text{ss}}': '\\rhost',
    '\\rho_{\\text{st}}': '\\rhost',
    '\\rho_{\\text{sst}}': '\\rhost',
    '{\\text{ss}}': '{\\text{st}}',
    '{\\text{sst}}': '{\\text{st}}',
    '\\rho^{st}': '\\rhost',
    '\\rho^{eq}': '\\rhoeq',
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
  },
};

// Combined replacements for backward compatibility
export const MAX_STYLE_REPLACEMENTS: ReplacementCategory = {
  name: 'max_style',
  description: 'Maximum style replacements for LaTeX commands and symbols',
  isRegex: false,
  patterns: (() => {
    const combinedPatterns = {
      ...MAX_AUTO_REPLACEMENTS.patterns,
      ...MAX_MANUAL_REPLACEMENTS.patterns,
    };
    return combinedPatterns;
  })(),
};

// Helper to create | separated regex part from a list of words
const createWordRegexPart = (words: string[]): string => words.join('|');

// Define the comprehensive list of all trigger words (from our previous discussion)
// prettier-ignore
// Define the comprehensive list of all trigger words (from our previous discussion)
const _fullWordsArrayInternal = [
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
const _sepWordsArrayInternal = [
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
const _gepWordsArrayInternal = _fullWordsArrayInternal.filter(
  (word) => !_sepWordsArrayInternal.includes(word),
);

// Create regex parts for use in the patterns object
const SEP_WORDS_REGEX_PART_INTERNAL = createWordRegexPart(
  _sepWordsArrayInternal,
);
const GEP_WORDS_REGEX_PART_INTERNAL = createWordRegexPart(
  _gepWordsArrayInternal,
);
const FULL_WORDS_REGEX_PART_INTERNAL = createWordRegexPart(
  _fullWordsArrayInternal,
);

// Pre-construct the regex patterns
const SEP_WORDS_CREF_EQN_PATTERN = `(${SEP_WORDS_REGEX_PART_INTERNAL})(?:,)?\\s+\\\\cref\\{(eqn:[^,}]+)\\}`;
const GEP_WORDS_CREF_EQN_PATTERN = `(${GEP_WORDS_REGEX_PART_INTERNAL})(?:,)?\\s+\\\\cref\\{(eqn:[^,}]+)\\}`;
const GEP_WORDS_EQREF_EQN_PATTERN = `(${GEP_WORDS_REGEX_PART_INTERNAL})(?:,)?\\s+\\\\eqref\\{(eqn:[^,}]+)\\}`;
const SEP_WORDS_PAREN_CREF_EQN_PATTERN = `(${SEP_WORDS_REGEX_PART_INTERNAL})(?:,)?\\s+\\(\\\\cref\\{(eqn:[^,}]+)\\}\\)`;
const GEP_WORDS_PAREN_CREF_EQN_PATTERN = `(${GEP_WORDS_REGEX_PART_INTERNAL})(?:,)?\\s+\\(\\\\cref\\{(eqn:[^,}]+)\\}\\)`;
const GEP_WORDS_PAREN_EQREF_EQN_PATTERN = `(${GEP_WORDS_REGEX_PART_INTERNAL})(?:,)?\\s+\\(\\\\eqref\\{(eqn:[^,}]+)\\}\\)`;
const FULL_WORDS_CREF_FIG_PATTERN = `(${FULL_WORDS_REGEX_PART_INTERNAL})(?:,)?\\s+\\\\cref\\{(fig:[^,}]+)\\}`;

export const MAX_REGEX_REPLACEMENTS: ReplacementCategory = {
  name: 'max_style_regex',
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

    // PUNCTUATION AND SPACING

    // Spell words with the following preﬁxes solid and not hyphenated: anti, co, counter, extra, inter, intra, macro, micro, multi, non, over, post, pre, pro, pseudo, psycho, re, semi, socio, sub, trans.
    '\\b(anti|co|counter|extra|inter|intra|macro|micro|multi|non|over|post|pre|pro|pseudo|psycho|re|semi|socio|sub|trans)-([a-z]+)':
      '$1$2',

    // GROUP 1: PARENTHESIZED REFERENCES
    // Single equation in parentheses (\cref{eqn:...})
    '\\(\\\\cref\\{(eqn:[^,}]+)\\}\\)': '(eqn.~\\ref{$1})',

    // --- Custom word list based \cref{eqn:...} replacements ---
    // Special words (equation, SDE, formula) before non-parenthesized \cref{eqn:...}
    [SEP_WORDS_CREF_EQN_PATTERN]: '$1~\\ref{$2}',

    // General words before non-parenthesized \cref{eqn:...}
    [GEP_WORDS_CREF_EQN_PATTERN]: '$1 eqn.~\\ref{$2}',

    // General
    [GEP_WORDS_EQREF_EQN_PATTERN]: '$1 eqn.~\\ref{$2}',

    // Special pattern for "and \cref"
    'and\\s+\\\\cref\\{(eqn:[^,}]+)\\}': 'and eqn.~\\ref{$1}',

    // Special words (equation, SDE, formula) before parenthesized \cref{eqn:...}
    [SEP_WORDS_PAREN_CREF_EQN_PATTERN]: '$1~(\\ref{$2})',

    // General words before parenthesized \cref{eqn:...}
    [GEP_WORDS_PAREN_CREF_EQN_PATTERN]: '$1 eqn.~(\\ref{$2})',

    // General words before \eqref{eqn:...}
    [GEP_WORDS_PAREN_EQREF_EQN_PATTERN]: '$1 eqn.~\\ref{$2}',

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
    [FULL_WORDS_CREF_FIG_PATTERN]: '$1 Figure~\\ref{$2}',
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
