/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - log
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

const CHANNEL = 'ReplacementEngine';
logger.initialize(CHANNEL);

// Local file imports
import {
  ReplacementCategory,
  ReplacementFunction,
  ReplacementValue,
} from './types';
import {
  applyLatexQuotesFormatting,
  replaceMathUnicode,
  fixLatexQuoteIssues,
  escapeTextttUnderscores,
  wrapCritiqueInAlign,
} from './advanced';
import {
  EQUATION_REPLACEMENTS,
  EQUATION_MACRO_REPLACEMENTS,
  SECTION_REPLACEMENTS,
  LATEX_FORBIDDEN_REPLACEMENTS,
  CHARACTER_REPLACEMENTS,
  FONT_COMMAND_REPLACEMENTS,
  UNICODE_REPLACEMENTS,
  HTML_ENTITY_REPLACEMENTS,
  LATEX_SPACING_REPLACEMENTS,
  LATEX_XML_REPLACEMENTS,
  LATEX_DOCUMENT_REPLACEMENTS,
  SCRATCHPAD_XML_REPLACEMENTS,
  GPTNESS_REPLACEMENTS,
  PERSONAL_STYLE_REPLACEMENTS,
  LATEXDIFF_REPLACEMENTS,
} from './rules';
import { MAX_STYLE_REPLACEMENTS, MAX_REGEX_REPLACEMENTS } from './maxRules';
import {
  PARENTHESES_REPLACEMENTS,
  LATEXDIFF_MARKUP_REPLACEMENTS,
  INLINE_MATH_REPLACEMENTS,
  EQUATION_STYLE_REPLACEMENTS,
  PERSONAL_STYLE_CONTEXTUAL_REPLACEMENTS,
  FENCED_LATEX_BLOCK_REPLACEMENTS,
} from './rulesRegex';

export interface ReplacementEngine {
  applyNonRegex(text: string): string;
  applyRegex(text: string): string;
  applyAll(text: string): string;
}

class ReplacementEngineImpl implements ReplacementEngine {
  /**
   * Apply all configured non-regex replacement rules.
   *
   * @param text The text to process.
   * @returns The processed text with non-regex rules applied.
   * @remarks Reads extension settings to determine enabled categories.
   */
  applyNonRegex(text: string): string {
    let processed = applyReplacements(text, getAllReplacements()).trim();
    if (shouldWrapCritiqueInAlign()) {
      processed = wrapCritiqueInAlign(processed);
    }
    return processed;
  }

  /**
   * Apply all configured regex-based replacement rules.
   *
   * @param text The text to process.
   * @returns The processed text with regex rules applied.
   * @remarks Invalid patterns are logged by {@link applyReplacements}.
   */
  applyRegex(text: string): string {
    return applyReplacements(text, getAllReplacementsRegex()).trim();
  }

  /**
   * Apply every replacement rule in the recommended order.
   *
   * Non-regex replacements run before and after regex replacements to fix
   * artifacts they may introduce.
   *
   * @param text The text to process.
   * @returns The fully processed text with non-regex and regex rules applied in sequence.
   */
  applyAll(text: string): string {
    let processed = this.applyNonRegex(text);
    processed = this.applyRegex(processed);
    return this.applyNonRegex(processed);
  }
}

// ===== LaTeX Content Formatting =====

// Define all available non-regex categories
const NON_REGEX_CATEGORIES: ReplacementCategory[] = [
  // LaTeX Content Formatting
  EQUATION_REPLACEMENTS,
  SECTION_REPLACEMENTS,
  LATEX_FORBIDDEN_REPLACEMENTS,
  CHARACTER_REPLACEMENTS,
  FONT_COMMAND_REPLACEMENTS,
  UNICODE_REPLACEMENTS,
  HTML_ENTITY_REPLACEMENTS,
  LATEX_SPACING_REPLACEMENTS,
  // XML/Structural Formatting
  LATEX_XML_REPLACEMENTS,
  LATEX_DOCUMENT_REPLACEMENTS,
  SCRATCHPAD_XML_REPLACEMENTS,
  GPTNESS_REPLACEMENTS,
  // Personal Style
  PERSONAL_STYLE_REPLACEMENTS,
  MAX_STYLE_REPLACEMENTS,
  // LaTeXdiff specific fixes
  LATEXDIFF_REPLACEMENTS,
];

// Define all available regex categories
const REGEX_CATEGORIES: ReplacementCategory[] = [
  EQUATION_MACRO_REPLACEMENTS,
  FENCED_LATEX_BLOCK_REPLACEMENTS,
  INLINE_MATH_REPLACEMENTS,
  PARENTHESES_REPLACEMENTS,
  LATEXDIFF_MARKUP_REPLACEMENTS,
  EQUATION_STYLE_REPLACEMENTS,
  PERSONAL_STYLE_CONTEXTUAL_REPLACEMENTS,
  MAX_REGEX_REPLACEMENTS,
];

function shouldWrapCritiqueInAlign(): boolean {
  return getConfig('texra.latex.wrapCritiqueInAlign', true);
}

/**
 * Get all non-regex replacements combined into a single category.
 * These replacements are subject to user configuration via enabledReplacements.
 */
export function getAllReplacements(): ReplacementCategory {
  const enabledCategoryNames = getConfig('texra.latex.enabledReplacements', [
    'latex_spacing',
    'equations',
    'sections',
    'latex_forbidden_commands',
    'characters',
    'font_commands',
    'latex_xml',
    'latex_document',
    'unicode',
    'html_entities',
    'scratchpad_xml',
    'gptness',
    'latexdiff',
  ]);
  const customReplacements = getConfig('texra.latex.customReplacements', {});

  // Filter predefined categories based on user configuration
  const enabledCategories = NON_REGEX_CATEGORIES.filter((category) =>
    enabledCategoryNames.includes(category.name),
  );

  // Combine patterns from all enabled categories with custom replacements taking precedence
  const allPatterns: { [key: string]: ReplacementValue } = Object.assign(
    {},
    ...enabledCategories.map((c) => c.patterns),
    customReplacements,
  );

  return {
    name: 'all',
    description: 'Combined non-regex replacements',
    isRegex: false,
    patterns: allPatterns,
  };
}

/**
 * Get all regex replacement categories in order of application.
 * Filter by enabled categories from user configuration.
 * Also includes custom regex replacements from settings.
 */
export function getAllReplacementsRegex(): ReplacementCategory[] {
  const enabledCategoryNames = getConfig(
    'texra.latex.enabledReplacementsRegex',
    [
      'fenced_latex_blocks',
      'inline_math',
      'tikz',
      'parentheses',
      'latexdiff_markup',
      'equation_style',
      'personal_style_contextual',
    ],
  );
  const customReplacements = getConfig(
    'texra.latex.customReplacementsRegex',
    {},
  );

  // Filter predefined categories based on user configuration
  let enabledCategories = REGEX_CATEGORIES.filter((category) =>
    enabledCategoryNames.includes(category.name),
  );

  // Add custom regex replacements as a separate category if any exist
  if (Object.keys(customReplacements).length > 0) {
    const customCategory: ReplacementCategory = {
      name: 'custom_regex',
      description: 'Custom regex replacements from user settings',
      isRegex: true,
      flags: 'g', // Default flags
      patterns: customReplacements,
    };

    // Add the custom category to the list
    enabledCategories = [...enabledCategories, customCategory];
  }

  return enabledCategories;
}

/**
 * Get replacement patterns for a specific category.
 */
export function getReplacementsByCategory(
  categoryName: string,
): ReplacementCategory | undefined {
  return (
    NON_REGEX_CATEGORIES.find((c) => c.name === categoryName) ??
    REGEX_CATEGORIES.find((c) => c.name === categoryName)
  );
}

/**
 * Apply replacements to text, handling both regex and non-regex patterns.
 * @param text The text to process
 * @param replacements The replacements to apply
 * @param options Optional configuration options
 * @param options.processMathUnicode Whether to apply Unicode-to-LaTeX within math environments (defaults to true)
 * @returns The processed text
 */
export function applyReplacements(
  text: string,
  replacements: ReplacementCategory | ReplacementCategory[],
  options?: {
    processMathUnicode?: boolean; // Whether to apply Unicode-to-LaTeX within math environments (defaults to true)
  },
): string {
  // Apply Unicode replacements in math environments if requested
  if (options?.processMathUnicode !== false) {
    // Default to true if not specified
    text = replaceMathUnicode(text);
  }

  // Convert single category to array for unified handling
  const replacementArray = Array.isArray(replacements)
    ? replacements
    : [replacements];

  // Process all replacements in order
  for (const category of replacementArray) {
    if (category.isRegex) {
      for (const [pattern, repl] of Object.entries(category.patterns)) {
        try {
          const regex = new RegExp(pattern, category.flags);
          text =
            typeof repl === 'string'
              ? text.replace(regex, repl)
              : text.replace(regex, repl);
        } catch (regexErr) {
          logger.error(
            CHANNEL,
            `Error with regex pattern "${pattern}": ${toErrorMessage(regexErr)}`,
          );
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        // Non-regex patterns only use string replacements
        if (typeof newText === 'string') {
          text = text.replaceAll(old, newText);
        } else {
          logger.debug(
            CHANNEL,
            `Skipping function pattern "${old}" in non-regex category "${category.name}"`,
          );
        }
      }
    }
  }

  // Apply LaTeX quotes formatting
  text = applyLatexQuotesFormatting(text);

  // Cleanup common quote issues
  text = fixLatexQuoteIssues(text);

  // Escape underscores inside \texttt commands for LaTeX compatibility
  text = escapeTextttUnderscores(text);

  return text;
}

/**
 * Clean content using all replacement rules.
 * @deprecated Use replacementEngine.applyAll() instead for the recommended order.
 * This function applies non-regex, then regex, then critique wrapping.
 * The engine's applyAll() method applies non-regex, regex, then non-regex again.
 */
export function cleanFileContent(content: string): string {
  let cleaned = applyReplacements(content, getAllReplacements()).trim();
  cleaned = applyReplacements(cleaned, getAllReplacementsRegex()).trim();
  return shouldWrapCritiqueInAlign() ? wrapCritiqueInAlign(cleaned) : cleaned;
}

/**
 * Provides high-level APIs for applying text replacement rules.
 */
export const replacementEngine: ReplacementEngine = new ReplacementEngineImpl();

export default replacementEngine;
