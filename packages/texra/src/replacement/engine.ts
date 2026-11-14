/**
 * Utilities for managing text replacements in the codebase.
 */

import { Effect, Result, Array as Arr } from 'effect';
import { LRUCache } from 'lru-cache';

import { Settings, withLogChannel } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type {
  NonRegexReplacementCategory,
  RegexReplacementCategory,
} from '@texra/shared/constants/replacementCategories';

import { NonRegexRuleSet, RegexRuleSet } from './types';
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
import type { ConfigProvider } from '@texra-ai/harness/host';
import {
  CUSTOM_REGEX_REPLACEMENTS_SETTING,
  CUSTOM_REPLACEMENTS_SETTING,
  ENABLED_REGEX_REPLACEMENTS_SETTING,
  ENABLED_REPLACEMENTS_SETTING,
} from '@texra/shared/settings/texraSettings';

const CHANNEL = 'ReplacementEngine';

/**
 * Plain string substitutions as the engine runs them, each through
 * `String.prototype.replaceAll`: longest `from` first, so a rule runs before
 * every shorter rule its `from` contains. A second pass chains one rule's
 * output into another.
 */
interface OrderedRuleSet {
  readonly rules: readonly (readonly [from: string, to: string])[];
  readonly isRegex?: false;
}

type ReplacementRuleSet = OrderedRuleSet | RegexRuleSet;

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
 * Run rule passes in order, each over the trimmed output of the one before.
 * A plain-string pass is followed by the critique wrapping; whole-document
 * cleanup runs once, in the last pass.
 */
function runPasses(
  text: string,
  passes: readonly (OrderedRuleSet | RegexRuleSet[])[],
): ReplacementResult {
  const diagnostics: ReplacementDiagnostic[] = [];
  let result = text;
  for (const [index, rules] of passes.entries()) {
    const applied = applyReplacements(result, rules, {
      cleanupPasses: index === passes.length - 1,
    });
    diagnostics.push(...applied.diagnostics);
    result = applied.text.trim();
    if (!Array.isArray(rules)) {
      result = wrapCritiqueInAlign(result);
    }
  }
  return { text: result, diagnostics };
}

function applyAllPolicy(
  text: string,
  config: ConfigProvider,
): ReplacementResult {
  const replacements = getAllReplacements(config);
  return runPasses(text, [
    replacements,
    getAllReplacementsRegex(config),
    replacements,
  ]);
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
   * `config` is the configuration of the workspace whose text this is; the
   * rules are its catalog settings, read through `Settings`.
   */
  applyAll: applyAllPolicy,

  /**
   * XML output normalization: the full non-regex pipeline (which already
   * covers `latex_xml`), then the fenced-LaTeX-block regex. The fenced-block
   * pass is unconditional here, independent of the `enabledReplacementsRegex`
   * config that gates {@link applyAll}'s regex pass. `config` is as for
   * {@link applyAll}.
   */
  applyToXmlContent(text: string, config: ConfigProvider): ReplacementResult {
    const nonRegex = runPasses(text, [getAllReplacements(config)]);
    const fenced = applyReplacements(
      nonRegex.text,
      FENCED_LATEX_BLOCK_REPLACEMENTS,
    );
    return {
      text: fenced.text,
      diagnostics: [...nonRegex.diagnostics, ...fenced.diagnostics],
    };
  },

  /**
   * A `.tex` file write: the full pipeline of {@link applyAll}, then the
   * LaTeX built-in section sign restored from the KaTeX-only destination.
   */
  applyToTexWrite(text: string, config: ConfigProvider): ReplacementResult {
    const all = applyAllPolicy(text, config);
    return { ...all, text: restoreLatexSectionSign(all.text) };
  },
};

/**
 * The rules behind every non-regex category name the config accepts. A
 * `Record` over that universe: a name with no rules here, or rules here under
 * a name the config rejects, fails to typecheck, so the engine can neither
 * accept a no-op category nor run one nobody can enable. A key two
 * categories share takes the later category's value.
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

/**
 * Every enabled non-regex category as one ordered rule set. A custom
 * replacement from user settings replaces the value of a predefined rule
 * with its key; the order is the rule set's own (longest `from` first).
 */
function getAllReplacements(config: ConfigProvider): OrderedRuleSet {
  const enabled = new Set<string>(
    Settings.getConfig(config, ENABLED_REPLACEMENTS_SETTING),
  );
  const customReplacements = Settings.getConfig(
    config,
    CUSTOM_REPLACEMENTS_SETTING,
  );

  const patterns: Record<string, string> = Object.assign(
    {},
    ...Object.entries(NON_REGEX_RULES)
      .filter(([name]) => enabled.has(name))
      .map(([, rules]) => rules.patterns),
    customReplacements,
  );

  // Sorted once, stably: rules of one length keep their declaration order.
  return {
    rules: Object.entries(patterns).toSorted(([a], [b]) => b.length - a.length),
  };
}

/**
 * Return every enabled regex category in application order, appending a custom
 * category built from user settings whenever custom regex replacements exist.
 */
function getAllReplacementsRegex(config: ConfigProvider): RegexRuleSet[] {
  const enabled = new Set<string>(
    Settings.getConfig(config, ENABLED_REGEX_REPLACEMENTS_SETTING),
  );
  const customReplacements = Settings.getConfig(
    config,
    CUSTOM_REGEX_REPLACEMENTS_SETTING,
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

function getCompiledRegex(pattern: string, flags: string): RegExp {
  const key = `${flags}\u0000${pattern}`;
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
function applyReplacements(
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

  for (const category of Arr.ensure(replacements)) {
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
      for (const [from, to] of category.rules) {
        result = result.replaceAll(from, to);
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
