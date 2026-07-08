export type ReplacementFunction = (
  match: string,
  // Regex capture groups, in order. A non-participating group is `undefined`,
  // which is why every callback treats these as `string | undefined`. (The
  // trailing offset/full-string args that `String.prototype.replace` also
  // passes are unused by every replacement here, so they are not modeled.)
  ...groups: (string | undefined)[]
) => string;

export type ReplacementValue = string | ReplacementFunction;

/** Plain string substitution, applied via `String.prototype.replaceAll`. */
export interface NonRegexReplacementCategory {
  name: string;
  description: string;
  patterns: Record<string, string>;
  isRegex?: false;
}

/** Regex-based substitution; patterns may be a replacement string or callback. */
export interface RegexReplacementCategory {
  name: string;
  description: string;
  patterns: Record<string, ReplacementValue>;
  isRegex: true;
  /** Regex flags such as 'g'. */
  flags?: string;
}

export type ReplacementCategory =
  NonRegexReplacementCategory | RegexReplacementCategory;
