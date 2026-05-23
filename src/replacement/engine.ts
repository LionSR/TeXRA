/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - common

// Local imports - log
import { getConfig } from '@agent/core/config';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ReplacementEngine';
logger.initialize(CHANNEL);

// Local file imports
import { ReplacementCategory, ReplacementValue } from './types';
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
   * Accepts optional pre-fetched config to avoid redundant getConfig() calls
   * when called multiple times (e.g. from applyAll).
   */
  applyNonRegex(
    text: string,
    preloaded?: { replacements: ReplacementCategory; wrapCritique: boolean },
  ): string {
    const replacements = preloaded?.replacements ?? getAllReplacements();
    const wrapCritique = preloaded?.wrapCritique ?? shouldWrapCritiqueInAlign();
    const processed = applyReplacements(text, replacements).trim();
    return wrapCritique ? wrapCritiqueInAlign(processed) : processed;
  }

  /**
   * Apply all configured regex-based replacement rules.
   */
  applyRegex(text: string): string {
    return applyReplacements(text, getAllReplacementsRegex()).trim();
  }

  /**
   * Apply every replacement rule in the recommended order.
   * Non-regex replacements run before and after regex replacements to fix
   * artifacts they may introduce.
   *
   * Config values are read once and reused across both non-regex passes
   * to avoid redundant getConfig() calls (~7 → 3 per invocation).
   */
  applyAll(text: string): string {
    // Snapshot config-derived data once for both non-regex passes.
    const preloaded = {
      replacements: getAllReplacements(),
      wrapCritique: shouldWrapCritiqueInAlign(),
    };

    const afterNonRegex = this.applyNonRegex(text, preloaded);
    const afterRegex = this.applyRegex(afterNonRegex);
    return this.applyNonRegex(afterRegex, preloaded);
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
  const enabledSet = new Set(enabledCategoryNames);
  const enabledCategories = NON_REGEX_CATEGORIES.filter((category) =>
    enabledSet.has(category.name),
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
 * Filters by enabled categories from user configuration and includes
 * custom regex replacements from settings.
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

  const enabledSet = new Set(enabledCategoryNames);
  const enabledCategories = REGEX_CATEGORIES.filter((category) =>
    enabledSet.has(category.name),
  );

  if (Object.keys(customReplacements).length === 0) {
    return enabledCategories;
  }

  return [
    ...enabledCategories,
    {
      name: 'custom_regex',
      description: 'Custom regex replacements from user settings',
      isRegex: true,
      flags: 'g',
      patterns: customReplacements,
    },
  ];
}

/**
 * Apply replacements to text, handling both regex and non-regex patterns.
 */
export function applyReplacements(
  text: string,
  replacements: ReplacementCategory | ReplacementCategory[],
  options?: {
    /** Whether to apply Unicode-to-LaTeX within math environments (defaults to true) */
    processMathUnicode?: boolean;
  },
): string {
  // Apply Unicode replacements in math environments unless disabled
  let result =
    options?.processMathUnicode === false ? text : replaceMathUnicode(text);

  const categories = Array.isArray(replacements)
    ? replacements
    : [replacements];

  for (const category of categories) {
    if (category.isRegex) {
      for (const [pattern, repl] of Object.entries(category.patterns)) {
        try {
          const regex = new RegExp(pattern, category.flags);
          result = result.replace(regex, repl as string);
        } catch (regexErr) {
          logger.error(
            CHANNEL,
            `Error with regex pattern "${pattern}": ${toErrorMessage(regexErr)}`,
          );
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        if (typeof newText === 'string') {
          result = result.replaceAll(old, newText);
        } else {
          logger.debug(
            CHANNEL,
            `Skipping function pattern "${old}" in non-regex category "${category.name}"`,
          );
        }
      }
    }
  }

  result = applyLatexQuotesFormatting(result);
  result = fixLatexQuoteIssues(result);
  result = escapeTextttUnderscores(result);

  return result;
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
