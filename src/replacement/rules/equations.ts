// Local imports - replacement
import {
  generateGroupedBackslashFixes,
  generateReferenceSpacing,
  generateEnvironmentLinebreakFixes,
  generateEnvironmentBracesFixes,
  GREEK_LETTERS,
  MATH_OPERATORS,
} from '@replacement/helpers';
import { ReplacementCategory } from '@replacement/types';

// Common LaTeX equation spacing fixes
export const EQUATION_REPLACEMENTS: ReplacementCategory = {
  name: 'equations',
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
    // Use the new grouped helper to organize the backslash fixes logically
    const groupedBackslashPatterns = generateGroupedBackslashFixes({
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
    });

    // Initialize patterns object with generated patterns
    const patterns: { [key: string]: string } = {
      ...linebreakFixesPatterns,
      ...referencePatterns,
      ...groupedBackslashPatterns,
    };

    // Greek letter notation fixes
    // Examples:
    // \a_ -> a_
    // \a^ -> a^
    // \x^ -> x^ [this should not be included]
    const letters = [...'abcdefghijklmnopqrstuvwyz'];
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
