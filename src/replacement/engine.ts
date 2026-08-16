/**
 * Utilities for managing text replacements in the codebase.
 */

import { LRUCache } from 'lru-cache';

import { createLog } from '@logger/logUtils';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';

import {
  ReplacementCategory,
  NonRegexReplacementCategory,
  RegexReplacementCategory,
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
import {
  LEGACY_UNBRACED_S_MIGRATION,
  MAX_STYLE_REPLACEMENTS,
  MAX_REGEX_REPLACEMENTS,
  restoreLatexSectionSign,
} from './maxRules';
import {
  EQUATION_MACRO_REPLACEMENTS,
  PARENTHESES_REPLACEMENTS,
  LATEXDIFF_MARKUP_REPLACEMENTS,
  INLINE_MATH_REPLACEMENTS,
  EQUATION_STYLE_REPLACEMENTS,
  PERSONAL_STYLE_CONTEXTUAL_REPLACEMENTS,
  FENCED_LATEX_BLOCK_REPLACEMENTS,
} from './rulesRegex';

const log = createLog('ReplacementEngine');

/**
 * Single policy owner for replacement rules. Call sites route through one of
 * these methods instead of composing lower-level rules themselves, so rule
 * selection, ordering, and failure handling stay in this module.
 */

function applyNonRegexPolicy(text: string): string {
  const processed = applyReplacements(text, getAllReplacements()).trim();
  return shouldWrapCritiqueInAlign()
    ? wrapCritiqueInAlign(processed)
    : processed;
}

function applyAllPolicy(text: string): string {
  const replacements = getAllReplacements();
  const wrapCritique = shouldWrapCritiqueInAlign();
  const maxStyleEnabled = getConfig<string[]>(
    'texra.latex.enabledReplacements',
    DEFAULT_CORE_SETTINGS.latex.enabledReplacements,
  ).includes('max_style');
  const maxStyleRegexEnabled = getConfig<string[]>(
    'texra.latex.enabledReplacementsRegex',
    DEFAULT_CORE_SETTINGS.latex.enabledReplacementsRegex,
  ).includes('max_style_regex');

  let result = applyReplacements(text, replacements, {
    cleanupPasses: false,
  }).trim();
  if (wrapCritique) result = wrapCritiqueInAlign(result);
  result = applyReplacements(result, getAllReplacementsRegex(), {
    cleanupPasses: false,
  }).trim();
  // The legacy unbraced S migration is a compatibility rule, not an
  // opt-in regex replacement: run it whenever the direct max-style group
  // produced the persisted output it repairs. When `max_style_regex` is
  // enabled, MAX_REGEX_REPLACEMENTS already contains the same rule.
  if (maxStyleEnabled && !maxStyleRegexEnabled) {
    result = applyReplacements(result, LEGACY_UNBRACED_S_MIGRATION, {
      cleanupPasses: false,
    }).trim();
  }
  result = applyReplacements(result, replacements).trim();
  return wrapCritique ? wrapCritiqueInAlign(result) : result;
}

const replacementEngine = {
  /** Apply all configured non-regex replacement rules. */
  applyNonRegex(text: string): string {
    return applyNonRegexPolicy(text);
  },

  /**
   * Apply every replacement rule in the recommended order. Non-regex
   * replacements run before and after regex replacements to fix artifacts they
   * may introduce. Config values are read once and reused across all passes, and
   * whole-document cleanup runs once at the end instead of after each pass.
   */
  applyAll(text: string): string {
    return applyAllPolicy(text);
  },

  /**
   * Purpose-specific replacement policy entry point. Call sites request the
   * exact ordered profile they need instead of composing lower-level rules at
   * the call site. Both special-purpose profiles have production consumers:
   * `xml-content` backs XML output normalization and `tex-write` backs
   * `.tex` file writes.
   */
  applyFor(text: string, purpose: 'xml-content' | 'tex-write'): string {
    switch (purpose) {
      case 'xml-content':
        // XML output normalization runs the full non-regex pipeline (which
        // already covers latex_xml) and then the fenced-LaTeX-block regex.
        // The fenced-block pass is deliberate and unconditional here: it is
        // part of this purpose's contract, independent of the
        // `enabledReplacementsRegex` config that gates applyAll's regex pass.
        return applyReplacements(
          applyNonRegexPolicy(text),
          FENCED_LATEX_BLOCK_REPLACEMENTS,
        );
      case 'tex-write':
        // Writing a .tex file runs the full pipeline and then restores the
        // LaTeX built-in section sign from the KaTeX-only destination.
        return restoreLatexSectionSign(applyAllPolicy(text));
    }
  },
};

/**
 * Non-regex categories, applied in this order. Exported so a completeness test
 * can assert this registry stays in sync with the config-facing name universe
 * (`NON_REGEX_REPLACEMENT_CATEGORIES` in `@shared/constants/latex`): a category
 * missing from this list silently never runs, and a universe name without an
 * entry here makes the config accept a no-op.
 */
export const NON_REGEX_CATEGORIES: NonRegexReplacementCategory[] = [
  // LaTeX content formatting
  EQUATION_REPLACEMENTS,
  SECTION_REPLACEMENTS,
  LATEX_FORBIDDEN_REPLACEMENTS,
  CHARACTER_REPLACEMENTS,
  FONT_COMMAND_REPLACEMENTS,
  UNICODE_REPLACEMENTS,
  HTML_ENTITY_REPLACEMENTS,
  LATEX_SPACING_REPLACEMENTS,
  // XML/structural formatting
  LATEX_XML_REPLACEMENTS,
  GPTNESS_REPLACEMENTS,
  // Personal style
  PERSONAL_STYLE_REPLACEMENTS,
  MAX_STYLE_REPLACEMENTS,
  // LaTeXdiff specific fixes
  LATEXDIFF_REPLACEMENTS,
];

/**
 * Regex categories, applied in this order. Exported for the same
 * registry/universe completeness check as {@link NON_REGEX_CATEGORIES}.
 */
export const REGEX_CATEGORIES: RegexReplacementCategory[] = [
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

function selectEnabledCategories<T extends ReplacementCategory>(
  categories: T[],
  enabledNames: string[],
): T[] {
  const enabled = new Set(enabledNames);
  return categories.filter((category) => enabled.has(category.name));
}

/**
 * Combine every enabled non-regex category into a single category. Custom
 * replacements from user settings take precedence over predefined rules.
 */
function getAllReplacements(): NonRegexReplacementCategory {
  const enabledNames = getConfig<string[]>(
    'texra.latex.enabledReplacements',
    DEFAULT_CORE_SETTINGS.latex.enabledReplacements,
  );
  const customReplacements = getConfig<Record<string, string>>(
    'texra.latex.customReplacements',
    {},
  );

  const enabledCategories = selectEnabledCategories(
    NON_REGEX_CATEGORIES,
    enabledNames,
  );
  const patterns: Record<string, string> = Object.assign(
    {},
    ...enabledCategories.map((c) => c.patterns),
    customReplacements,
  );

  return {
    name: 'all',
    description: 'Combined non-regex replacements',
    isRegex: false,
    patterns,
  };
}

/**
 * Return every enabled regex category in application order, appending a custom
 * category built from user settings whenever custom regex replacements exist.
 */
function getAllReplacementsRegex(): RegexReplacementCategory[] {
  const enabledNames = getConfig<string[]>(
    'texra.latex.enabledReplacementsRegex',
    DEFAULT_CORE_SETTINGS.latex.enabledReplacementsRegex,
  );
  const customReplacements = getConfig<Record<string, ReplacementValue>>(
    'texra.latex.customReplacementsRegex',
    {},
  );

  const enabledCategories = selectEnabledCategories(
    REGEX_CATEGORIES,
    enabledNames,
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
 * rather than dropping every entry at once. A `Map.clear()` on overflow would
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
    /** Whether to run trailing whole-document cleanup passes (defaults to true). */
    cleanupPasses?: boolean;
  },
): string {
  // Apply Unicode replacements in math environments first.
  let result = replaceMathUnicode(text);

  const categories = Array.isArray(replacements)
    ? replacements
    : [replacements];

  for (const category of categories) {
    if (category.isRegex) {
      for (const [pattern, repl] of Object.entries(category.patterns)) {
        try {
          const regex = getCompiledRegex(pattern, category.flags);
          // Both arms call the same `replace` overload with the same
          // arguments — the runtime behavior doesn't depend on the branch.
          // The `typeof` check exists only so TS can select a `replace`
          // overload; it can't choose one from `repl`'s union type directly.
          result =
            typeof repl === 'string'
              ? result.replace(regex, repl)
              : result.replace(regex, repl);
        } catch (regexErr) {
          log.error(
            `Error with regex pattern "${pattern}": ${toErrorMessage(regexErr)}`,
          );
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        result = result.replaceAll(old, newText);
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

export default replacementEngine;
