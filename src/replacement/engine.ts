/**
 * Utilities for managing text replacements in the codebase.
 */

import { Effect, Result } from 'effect';
import { LRUCache } from 'lru-cache';

import { withLogChannel } from '@logger/effectLog';
import type {
  NonRegexReplacementCategory,
  RegexReplacementCategory,
} from '@shared/constants/replacementCategories';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  ReplacementRuleSet,
  NonRegexRuleSet,
  RegexRuleSet,
  ReplacementValue,
} from './types';
import {
  applyLatexQuotesFormatting,
  type ReplacementDiagnostic,
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

const CHANNEL = 'ReplacementEngine';

/**
 * Replaced text plus what the passes had to say about it. The engine is pure,
 * so it returns its diagnostics and the program running it logs them with
 * {@link logReplacementDiagnostics}.
 */
interface ReplacementResult {
  readonly text: string;
  readonly diagnostics: readonly ReplacementDiagnostic[];
}

/** Write a replacement run's diagnostics on the engine's log channel. */
export function logReplacementDiagnostics(
  diagnostics: readonly ReplacementDiagnostic[],
): Effect.Effect<void> {
  return Effect.forEach(
    diagnostics,
    ({ level, message }) =>
      level === 'error' ? Effect.logError(message) : Effect.logDebug(message),
    { discard: true },
  ).pipe(withLogChannel(CHANNEL));
}

/**
 * How a policy reads its replacement settings by key: a reader over the
 * configuration of the workspace whose text is being rewritten, which every
 * caller holds as data.
 */
export type ReplacementConfigRead = <T>(path: string) => T;

function applyNonRegexPolicy(
  text: string,
  read: ReplacementConfigRead,
): ReplacementResult {
  const processed = applyReplacements(text, getAllReplacements(read));
  const trimmed = processed.text.trim();
  return {
    text: shouldWrapCritiqueInAlign(read)
      ? wrapCritiqueInAlign(trimmed)
      : trimmed,
    diagnostics: processed.diagnostics,
  };
}

function applyAllPolicy(
  text: string,
  read: ReplacementConfigRead,
): ReplacementResult {
  const replacements = getAllReplacements(read);
  const wrapCritique = shouldWrapCritiqueInAlign(read);

  const nonRegex = applyReplacements(text, replacements, {
    cleanupPasses: false,
  });
  let result = nonRegex.text.trim();
  if (wrapCritique) result = wrapCritiqueInAlign(result);
  const regex = applyReplacements(result, getAllReplacementsRegex(read), {
    cleanupPasses: false,
  });
  const final = applyReplacements(regex.text.trim(), replacements);
  result = final.text.trim();
  return {
    text: wrapCritique ? wrapCritiqueInAlign(result) : result,
    diagnostics: [
      ...nonRegex.diagnostics,
      ...regex.diagnostics,
      ...final.diagnostics,
    ],
  };
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
  ): ReplacementResult {
    switch (purpose) {
      case 'xml-content': {
        // XML output normalization runs the full non-regex pipeline (which
        // already covers latex_xml) and then the fenced-LaTeX-block regex.
        // The fenced-block pass is deliberate and unconditional here: it is
        // part of this purpose's contract, independent of the
        // `enabledReplacementsRegex` config that gates applyAll's regex pass.
        const nonRegex = applyNonRegexPolicy(text, read);
        const fenced = applyReplacements(
          nonRegex.text,
          FENCED_LATEX_BLOCK_REPLACEMENTS,
        );
        return {
          text: fenced.text,
          diagnostics: [...nonRegex.diagnostics, ...fenced.diagnostics],
        };
      }
      case 'tex-write': {
        // Writing a .tex file runs the full pipeline and then restores the
        // LaTeX built-in section sign from the KaTeX-only destination.
        const all = applyAllPolicy(text, read);
        return { ...all, text: restoreLatexSectionSign(all.text) };
      }
      default:
        return assertNever(purpose, 'Unknown replacement purpose');
    }
  },
};

/**
 * The rules behind every non-regex category name the config accepts, in the
 * order the engine applies them. A `Record` over that universe: a name with no
 * rules here, or rules here under a name the config rejects, fails to
 * typecheck, so the engine can neither accept a no-op category nor run one
 * nobody can enable. Application order is this declaration's key order, which
 * is behavior — a category applied later wins a duplicated pattern key — so
 * there is no second list to keep in step with it.
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

/**
 * The rules behind every regex category name, on the same contract; a regex
 * category applied later rewrites what an earlier one produced.
 */
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
    ...Object.entries(NON_REGEX_RULES)
      .filter(([name]) => enabled.has(name))
      .map(([, rules]) => rules.patterns),
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

  const enabledRules = Object.entries(REGEX_RULES)
    .filter(([name]) => enabled.has(name))
    .map(([, rules]) => rules);
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
): ReplacementResult {
  const diagnostics: ReplacementDiagnostic[] = [];
  // Apply Unicode replacements in math environments first.
  let result = replaceMathUnicode(text);

  const categories = Array.isArray(replacements)
    ? replacements
    : [replacements];

  for (const category of categories) {
    if (category.isRegex) {
      for (const [pattern, repl] of Object.entries(category.patterns)) {
        const current = result;
        const replaced = Result.try({
          try: () => {
            const regex = getCompiledRegex(pattern, category.flags);
            // Both arms call the same `replace` overload with the same
            // arguments — the runtime behavior doesn't depend on the branch.
            // The `typeof` check exists only so TS can select a `replace`
            // overload; it can't choose one from `repl`'s union type directly.
            return typeof repl === 'string'
              ? current.replace(regex, repl)
              : current.replace(regex, repl);
          },
          catch: toErrorMessage,
        });
        if (Result.isSuccess(replaced)) {
          result = replaced.success;
        } else {
          diagnostics.push({
            level: 'error',
            message: `Error with regex pattern "${pattern}": ${replaced.failure}`,
          });
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        result = result.replaceAll(old, newText);
      }
    }
  }

  if (options?.cleanupPasses !== false) {
    const quoted = applyLatexQuotesFormatting(result);
    diagnostics.push(...quoted.diagnostics);
    result = fixLatexQuoteIssues(quoted.text);
    result = escapeTextttUnderscores(result);
  }

  return { text: result, diagnostics };
}

export default replacementEngine;
