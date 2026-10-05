export type ReplacementFunction = (
  match: string,
  // Regex capture groups, in order. A non-participating group is `undefined`,
  // which is why every callback treats these as `string | undefined`. (The
  // trailing offset/full-string args that `String.prototype.replace` also
  // passes are unused by every replacement here, so they are not modeled.)
  ...groups: (string | undefined)[]
) => string;

export type ReplacementValue = string | ReplacementFunction;

/**
 * A rule set carries patterns only. Its category name is the key it sits
 * under in the engine's rule table, which is typed over
 * `@shared/constants/replacementCategories` — so a rule set cannot name
 * itself something the config does not accept, and the name is not restated
 * beside the rules.
 */

/** Plain string substitution, applied via `String.prototype.replaceAll`. */
export interface NonRegexRuleSet {
  patterns: Record<string, string>;
  isRegex?: false;
}

/** Regex-based substitution; patterns may be a replacement string or callback. */
export interface RegexRuleSet {
  patterns: Record<string, ReplacementValue>;
  isRegex: true;
  /** Regex flags such as 'g'. */
  flags?: string;
}

export type ReplacementRuleSet = NonRegexRuleSet | RegexRuleSet;
