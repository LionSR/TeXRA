/**
 * Utilities for managing text replacements in the codebase.
 */

import { LRUCache } from 'lru-cache';

import { createLog } from '@logger/logUtils';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
  type NonRegexReplacementCategory,
  type RegexReplacementCategory,
} from '@shared/constants/replacementCategories';

import {
  ReplacementRuleSet,
  NonRegexRuleSet,
  RegexRuleSet,
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
 * How a policy reads its replacement settings by key: a reader over the
 * configuration of the workspace whose text is being rewritten, which every
 * caller holds as data.
 */
export type ReplacementConfigRead = <T>(path: string) => T;

function applyNonRegexPolicy(
  text: string,
  read: ReplacementConfigRead,
): string {
  const processed = applyReplacements(text, getAllReplacements(read)).trim();
  return shouldWrapCritiqueInAlign(read)
    ? wrapCritiqueInAlign(processed)
    : processed;
}

function applyAllPolicy(text: string, read: ReplacementConfigRead): string {
  const replacements = getAllReplacements(read);
  const wrapCritique = shouldWrapCritiqueInAlign(read);

  let result = applyReplacements(text, replacements, {
    cleanupPasses: false,
  }).trim();
  if (wrapCritique) result = wrapCritiqueInAlign(result);
  result = applyReplacements(result, getAllReplacementsRegex(read), {
    cleanupPasses: false,
  }).trim();
  result = applyReplacements(result, replacements).trim();
  return wrapCritique ? wrapCritiqueInAlign(result) : result;
}

/**
 * Single policy owner for replacement rules. Call sites route through one of
 * these methods instead of composing lower-level rules themselves, so rule
 * selection, ordering, and failure handling stay in this module.
 */
const replacementEngine = {
  /**
   * Apply every replacement rule in the recommended order. Non-regex
   * replacements run before and after regex replacements to fix artifacts they
   * may introduce. Config values are read once and reused across all passes, and
   * whole-document cleanup runs once at the end instead of after each pass.
   * `read` reads the rules from the configuration of the workspace whose text
   * this is.
   */
  applyAll: applyAllPolicy,

  /**
   * Purpose-specific replacement policy entry point. Call sites request the
   * exact ordered profile they need instead of composing lower-level rules at
   * the call site. Both special-purpose profiles have production consumers:
   * `xml-content` backs XML output normalization and `tex-write` backs
   * `.tex` file writes. `read` is as for {@link applyAll}.
   */
  applyFor(
    text: string,
    purpose: 'xml-content' | 'tex-write',
    read: ReplacementConfigRead,
  ): string {
    switch (purpose) {
      case 'xml-content':
        // XML output normalization runs the full non-regex pipeline (which
        // already covers latex_xml) and then the fenced-LaTeX-block regex.
        // The fenced-block pass is deliberate and unconditional here: it is
        // part of this purpose's contract, independent of the
        // `enabledReplacementsRegex` config that gates applyAll's regex pass.
        return applyReplacements(
          applyNonRegexPolicy(text, read),
          FENCED_LATEX_BLOCK_REPLACEMENTS,
        );
      case 'tex-write':
        // Writing a .tex file runs the full pipeline and then restores the
        // LaTeX built-in section sign from the KaTeX-only destination.
        return restoreLatexSectionSign(applyAllPolicy(text, read));
      default:
        return assertNever(purpose, 'Unknown replacement purpose');
    }
  },
};

/**
 * The rules behind every non-regex category name the config accepts. A
 * `Record` over that universe: a name with no rules here, or rules here under
 * a name the config rejects, fails to typecheck, so the engine can neither
 * accept a no-op category nor run one nobody can enable. Application order is
 * the universe's own order — see
 * {@link NON_REGEX_REPLACEMENT_CATEGORIES}.
 */
const NON_REGEX_RULES: Record<NonRegexReplacementCategory, NonRegexRuleSet> = {
  // LaTeX content formatting
  equations: EQUATION_REPLACEMENTS,
  sections: SECTION_REPLACEMENTS,
  latex_forbidden_commands: LATEX_FORBIDDEN_REPLACEMENTS,
  characters: CHARACTER_REPLACEMENTS,
  font_commands: FONT_COMMAND_REPLACEMENTS,
  unicode: UNICODE_REPLACEMENTS,
  html_entities: HTML_ENTITY_REPLACEMENTS,
  latex_spacing: LATEX_SPACING_REPLACEMENTS,
  // XML/structural formatting
  latex_xml: LATEX_XML_REPLACEMENTS,
  gptness: GPTNESS_REPLACEMENTS,
  // Personal style
  personal_style: PERSONAL_STYLE_REPLACEMENTS,
  max_style: MAX_STYLE_REPLACEMENTS,
  // LaTeXdiff specific fixes
  latexdiff: LATEXDIFF_REPLACEMENTS,
};

/** The rules behind every regex category name, on the same contract. */
const REGEX_RULES: Record<RegexReplacementCategory, RegexRuleSet> = {
  equation_macros: EQUATION_MACRO_REPLACEMENTS,
  fenced_latex_blocks: FENCED_LATEX_BLOCK_REPLACEMENTS,
  inline_math: INLINE_MATH_REPLACEMENTS,
  parentheses: PARENTHESES_REPLACEMENTS,
  latexdiff_markup: LATEXDIFF_MARKUP_REPLACEMENTS,
  equation_style: EQUATION_STYLE_REPLACEMENTS,
  personal_style_contextual: PERSONAL_STYLE_CONTEXTUAL_REPLACEMENTS,
  max_style_regex: MAX_REGEX_REPLACEMENTS,
};

function shouldWrapCritiqueInAlign(read: ReplacementConfigRead): boolean {
  return read('texra.latex.wrapCritiqueInAlign');
}

/**
 * Combine every enabled non-regex category into a single category. Custom
 * replacements from user settings take precedence over predefined rules.
 */
function getAllReplacements(read: ReplacementConfigRead): NonRegexRuleSet {
  const enabled = new Set(read<string[]>('texra.latex.enabledReplacements'));
  const customReplacements = read<Record<string, string>>(
    'texra.latex.customReplacements',
  );

  const patterns: Record<string, string> = Object.assign(
    {},
    ...NON_REGEX_REPLACEMENT_CATEGORIES.filter((name) =>
      enabled.has(name),
    ).map((name) => NON_REGEX_RULES[name].patterns),
    customReplacements,
  );

  return { patterns };
}

/**
 * Return every enabled regex category in application order, appending a custom
 * category built from user settings whenever custom regex replacements exist.
 */
function getAllReplacementsRegex(read: ReplacementConfigRead): RegexRuleSet[] {
  const enabled = new Set(
    read<string[]>('texra.latex.enabledReplacementsRegex'),
  );
  const customReplacements = read<Record<string, ReplacementValue>>(
    'texra.latex.customReplacementsRegex',
  );

  const enabledRules = REGEX_REPLACEMENT_CATEGORIES.filter((name) =>
    enabled.has(name),
  ).map((name) => REGEX_RULES[name]);
  if (Object.keys(customReplacements).length === 0) {
    return enabledRules;
  }

  return [
    ...enabledRules,
    { isRegex: true, flags: 'g', patterns: customReplacements },
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
  replacements: ReplacementRuleSet | ReplacementRuleSet[],
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
