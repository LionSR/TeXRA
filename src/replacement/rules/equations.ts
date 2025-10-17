// Local imports - replacement
import {
  generateGroupedBackslashFixes,
  generateReferenceSpacing,
  generateEnvironmentLinebreakFixes,
  generateEnvironmentBracesFixes,
  GREEK_LETTERS,
  MATH_OPERATORS,
} from '../helpers';
import { ReplacementCategory } from '../types';

// Common LaTeX equation spacing fixes
export const EQUATION_REPLACEMENTS: ReplacementCategory = {
  name: 'equations',
  description: 'Fixes for LaTeX equation spacing and formatting',
  isRegex: false,
  patterns: (() => {
    // Initialize patterns object for auto-generated items
    const patterns: { [key: string]: string } = {};

    // ====================================================================
    // Auto-generated replacements - for easily maintainable pattern groups
    // ====================================================================

    // ===== Environment spacing fixes =====
    // Examples:
    // \n\n\begin{align} -> \n\begin{align}
    // \end{equation}\n\n -> \end{equation}\n
    // const envSpacingPatterns = generateEnvironmentSpacingFixes(
    //   MATH_ENVIRONMENTS.slice(0, 2),
    // );
    // Object.assign(patterns, envSpacingPatterns);
    // This is too aggressive

    // ===== Linebreak fixes within environments =====
    // Examples:
    // \n\n\end{align} -> \n\end{align}
    // \n    \n\end{aligned} -> \n\end{aligned}
    const linebreakFixesPatterns = generateEnvironmentLinebreakFixes(
      'align aligned'.split(' '),
    );
    Object.assign(patterns, linebreakFixesPatterns);

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
    Object.assign(patterns, referencePatterns);

    // ===== Grouped backslash fixes =====
    // Use the new grouped helper to organize the backslash fixes logically
    const groupedBackslashPatterns = generateGroupedBackslashFixes({
      mathOperators: MATH_OPERATORS.concat(['pi', 'bna']),
      greekLetters: GREEK_LETTERS.concat([
        'partial',
        'Delta',
        'Gamma',
        'Lambda',
        'Sigma',
        'Omega',
      ]),
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
    });
    Object.assign(patterns, groupedBackslashPatterns);

    // Greek letter notation fixes
    // Examples:
    // \a_ -> a_
    // \a^ -> a^
    // \x^ -> x^ [this should not be included]
    const letters = 'abcdefghijklmnopqrstuvwyz'.split('');
    letters.forEach((letter) => {
      patterns[`\\${letter}_`] = `${letter}_`;
      patterns[`\\${letter}^`] = `${letter}^`;
    });

    // ===== Environment end command fixes =====
    // Examples:
    // \n\\nend{align} -> \n\end{align}
    // \n\\nend{document} -> \n\end{document}
    const environments =
      'align equation itemize enumerate figure tikzpicture document'.split(' ');
    environments.forEach((env) => {
      patterns[`\n\\\nend{${env}}`] = `\n\\end{${env}}`;
    });

    // ===== Environment braces/brackets fixes =====
    // Examples:
    // {\align} -> {align}
    // {\document} -> {document}
    const bracesEnvironments =
      'align equation itemize enumerate figure tikzpicture document'.split(' ');
    const bracesFixes = generateEnvironmentBracesFixes(bracesEnvironments);
    Object.assign(patterns, bracesFixes);

    // ===================================================================
    // Manual replacements - for specific cases that need special handling
    // ===================================================================

    // Note: latexdiff compatibility fixes moved to dedicated LATEXDIFF_REPLACEMENTS category

    // Ensure modulo operators use LaTeX's dedicated commands instead of font macros
    const moduloOperators = ['mod', 'bmod', 'pmod'];
    moduloOperators.forEach((operator) => {
      patterns[`\\mathrm{${operator}}`] = `\\${operator}`;
      patterns[`\\text{${operator}}`] = `\\${operator}`;
      patterns[`\\textrm{${operator}}`] = `\\${operator}`;
      patterns[`\\mbox{${operator}}`] = `\\${operator}`;
      patterns[`{\\rm ${operator}}`] = `\\${operator}`;
    });

    // Additional specific Greek letter fixes
    patterns['\\\\\\rho'] = '\\rho';
    patterns['\\\\\\delta'] = '\\delta';

    // Additional specific fixes for rho
    patterns['\\\\rho_'] = '\\rho_';
    patterns['\\\\rho^'] = '\\rho^';
    patterns['\\\\rho\\'] = '\\rho\\';

    // Fix line breaks in delimiters
    patterns['\\right\n)'] = '\\right)';
    patterns['\\right\n]'] = '\\right]';
    patterns['\\right\n}'] = '\\right}';
    patterns['\\left\n('] = '\\left(';
    patterns['\\left\n['] = '\\left[';
    patterns['\\left\n{'] = '\\left{';

    // Fix variable notations with wrong backslashes
    patterns['\\\\e^'] = 'e^';

    // Label spacing fixes
    patterns[',    \\label{'] = ',\\label{';
    patterns[',  \\label{'] = ',\\label{';
    patterns[',        \\label{'] = ',\\label{';
    patterns['\\\nlabel{'] = '\\label{';

    // Environment name fixes
    patterns['\\end{Galign}'] = '\\end{align}';

    // Unusual line/paragraph separators (Gemini problem)
    patterns['/[\u2028\u2029]/g'] = '\n';

    patterns[':\\colon'] = '\\colon';
    return patterns;
  })(),
};

export default EQUATION_REPLACEMENTS;
