/**
 * Utilities for managing text replacements in the codebase.
 */

// Third-party imports
import { LRUCache } from 'lru-cache';

// Local imports - common

// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { getConfig } from '@utils/config/configUtils';

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
   */
  applyNonRegex(text: string): string {
    const processed = applyReplacements(text, getAllReplacements()).trim();
    return shouldWrapCritiqueInAlign()
      ? wrapCritiqueInAlign(processed)
      : processed;
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
   * Config values are read once and reused across all passes. Whole-document
   * cleanup runs once at the end instead of after each intermediate pass.
   */
  applyAll(text: string): string {
    const replacements = getAllReplacements();
    const wrapCritique = shouldWrapCritiqueInAlign();

    let result = applyReplacements(text, replacements, {
      cleanupPasses: false,
    }).trim();
    if (wrapCritique) result = wrapCritiqueInAlign(result);
    result = applyReplacements(result, getAllReplacementsRegex(), {
      cleanupPasses: false,
    }).trim();
    result = applyReplacements(result, replacements).trim();
    return wrapCritique ? wrapCritiqueInAlign(result) : result;
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
function getAllReplacements(): ReplacementCategory {
  const enabledCategoryNames = getConfig<string[]>(
    'texra.latex.enabledReplacements',
    DEFAULT_CORE_SETTINGS.latex.enabledReplacements,
  );
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
function getAllReplacementsRegex(): ReplacementCategory[] {
  const enabledCategoryNames = getConfig<string[]>(
    'texra.latex.enabledReplacementsRegex',
    DEFAULT_CORE_SETTINGS.latex.enabledReplacementsRegex,
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
 * Cache compiled replacement regexes keyed by pattern and flags. The replacement
 * engine runs several times per model response over mostly static rule sets, so
 * compiling each pattern once removes repeated RegExp construction from the
 * streaming hot path.
 *
 * Bounded by an LRU so overflow evicts only the least-recently-used entry
 * rather than dropping every entry at once — a `Map.clear()` on overflow would
 * cold-recompile every active pattern on the next streamed chunk. Caching is
 * safe even for global (`g`) patterns: they are only ever consumed via
 * `String.prototype.replace`, which resets `lastIndex` around each call, so a
 * shared RegExp instance carries no per-call state between replacements.
 */
const MAX_COMPILED_REGEX_CACHE = 1000;
const compiledRegexCache = new LRUCache<string, RegExp>({
  max: MAX_COMPILED_REGEX_CACHE,
});

function getCompiledRegex(pattern: string, flags?: string): RegExp {
  const key = `${flags ?? ''}\u0000${pattern}`;
  const cached = compiledRegexCache.get(key);
  if (cached) {
    return cached;
  }

  const regex = new RegExp(pattern, flags);
  compiledRegexCache.set(key, regex);
  return regex;
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
    /** Whether to run trailing whole-document cleanup passes (defaults to true). */
    cleanupPasses?: boolean;
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
          const regex = getCompiledRegex(pattern, category.flags);
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

  if (options?.cleanupPasses !== false) {
    result = applyLatexQuotesFormatting(result);
    result = fixLatexQuoteIssues(result);
    result = escapeTextttUnderscores(result);
  }

  return result;
}

/**
 * Provides high-level APIs for applying text replacement rules.
 */
const replacementEngine: ReplacementEngine = new ReplacementEngineImpl();

export default replacementEngine;
