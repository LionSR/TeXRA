/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - log
import * as logger from '../logger/logUtils';

// Import vscode workspace configuration
import { getConfig } from '../utils/configUtils';

const CHANNEL = 'ReplacementUtils';
logger.initialize(CHANNEL);

import { ReplacementCategory } from './replacementTypes';
import {
  applyLatexQuotesFormatting,
  replaceMathUnicode,
} from './replacementAdvanced';

import {
  EQUATION_REPLACEMENTS,
  SECTION_REPLACEMENTS,
  CHARACTER_REPLACEMENTS,
  UNICODE_REPLACEMENTS,
  LATEX_SPACING_REPLACEMENTS,
  LATEX_XML_REPLACEMENTS,
  LATEX_DOCUMENT_REPLACEMENTS,
  SCRATCHPAD_XML_REPLACEMENTS,
  STYLE_REPLACEMENTS,
  PERSONAL_STYLE_REPLACEMENTS,
  LATEXDIFF_REPLACEMENTS,
} from './replacementRules';
import { MAX_STYLE_REPLACEMENTS } from './replacementMax';

import {
  PARENTHESES_REPLACEMENTS,
  LATEXDIFF_MARKUP_REPLACEMENTS,
  INLINE_MATH_REPLACEMENTS,
  TIKZ_REPLACEMENTS,
  EQUATION_STYLE_REPLACEMENTS,
} from './replacementRulesRegex';

// ===== LaTeX Content Formatting =====

/**
 * Get enabled replacement categories from VS Code settings
 */
function getEnabledReplacements(): string[] {
  return getConfig('latex.enabledReplacements', [
    'latex_spacing',
    'equations',
    'sections',
    'characters',
    'latex_xml',
    'latex_document',
    'unicode',
    'scratchpad_xml',
    'style',
    'latexdiff',
  ]);
}

// Define all available non-regex categories
const NON_REGEX_CATEGORIES: ReplacementCategory[] = [
  // LaTeX Content Formatting
  EQUATION_REPLACEMENTS,
  SECTION_REPLACEMENTS,
  CHARACTER_REPLACEMENTS,
  UNICODE_REPLACEMENTS,
  LATEX_SPACING_REPLACEMENTS,
  // XML/Structural Formatting
  LATEX_XML_REPLACEMENTS,
  LATEX_DOCUMENT_REPLACEMENTS,
  SCRATCHPAD_XML_REPLACEMENTS,
  STYLE_REPLACEMENTS,
  // Personal Style
  PERSONAL_STYLE_REPLACEMENTS,
  MAX_STYLE_REPLACEMENTS,
  // LaTeXdiff specific fixes
  LATEXDIFF_REPLACEMENTS,
];

// Define all available regex categories
const REGEX_CATEGORIES: ReplacementCategory[] = [
  INLINE_MATH_REPLACEMENTS,
  TIKZ_REPLACEMENTS,
  PARENTHESES_REPLACEMENTS,
  LATEXDIFF_MARKUP_REPLACEMENTS,
  EQUATION_STYLE_REPLACEMENTS,
];

/**
 * Get enabled regex replacement categories from VS Code settings
 */
function getEnabledReplacementsRegex(): string[] {
  return getConfig('latex.enabledReplacementsRegex', [
    'inline_math',
    'tikz',
    'parentheses',
    'latexdiff_markup',
    'equation_style',
  ]);
}

/**
 * Get custom replacements from VS Code settings
 */
function getCustomReplacements(): { [key: string]: string } {
  return getConfig('latex.customReplacements', {});
}

/**
 * Get custom regex replacements from VS Code settings
 */
function getCustomReplacementsRegex(): { [key: string]: string } {
  return getConfig('latex.customReplacementsRegex', {});
}

/**
 * Get all non-regex replacements combined into a single category.
 * These replacements are subject to user configuration via enabledReplacements.
 */
export function getAllReplacements(): ReplacementCategory {
  const enabledCategoryNames = getEnabledReplacements();
  const customReplacements = getCustomReplacements();

  // Filter predefined categories based on user configuration
  const enabledCategories = NON_REGEX_CATEGORIES.filter((category) =>
    enabledCategoryNames.includes(category.name),
  );

  // Combine patterns from all enabled categories
  let allPatterns: { [key: string]: string } = {};
  enabledCategories.forEach((category) => {
    allPatterns = { ...allPatterns, ...category.patterns };
  });

  // Add custom replacements (these take precedence over built-in ones)
  allPatterns = { ...allPatterns, ...customReplacements };

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
  const enabledCategoryNames = getEnabledReplacementsRegex();
  const customReplacements = getCustomReplacementsRegex();

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
  // Define all available categories
  const allCategories = [...NON_REGEX_CATEGORIES, ...REGEX_CATEGORIES];

  // Create a map for efficient lookup by name
  const categoryMap = new Map<string, ReplacementCategory>();

  // Add all categories to the map
  allCategories.forEach((category) => {
    categoryMap.set(category.name, category);
  });

  // Return the requested category if it exists
  return categoryMap.get(categoryName);
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
  // // By default, math-Unicode replacements are NOT applied.
  // // To enable them, call applyReplacements(..., { processMathUnicode: true })
  // if (options?.processMathUnicode === true) {
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
          text = text.replace(
            new RegExp(pattern, category.flags),
            repl as string,
          );
        } catch (regexErr) {
          logger.error(
            CHANNEL,
            `Error with regex pattern "${pattern}": ${regexErr instanceof Error ? regexErr.message : String(regexErr)}`,
          );
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        text = text.replaceAll(old, newText as string);
      }
    }
  }

  // Apply LaTeX quotes formatting
  text = applyLatexQuotesFormatting(text);

  return text;
}
