export type ReplacementFunction = (
  match: string,
  // Regex capture groups, in order. A non-participating group is `undefined`,
  // which is why every callback treats these as `string | undefined`. (The
  // trailing offset/full-string args that `String.prototype.replace` also
  // passes are unused by every replacement here, so they are not modeled.)
  ...groups: (string | undefined)[]
) => string;

type ReplacementValue = string | ReplacementFunction;

/**
 * Regex-based substitution; patterns may be a replacement string or callback.
 * Plain string rule sets are bare `Record<string, string>` tables. A rule
 * set's category name is the key it sits under in the engine's rule table, so
 * neither kind restates its name or its kind beside the rules.
 */
export interface RegexRuleSet {
  patterns: Record<string, ReplacementValue>;
  /** Regex flags such as 'g'. */
  flags: string;
}
