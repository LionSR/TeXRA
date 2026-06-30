export type ReplacementFunction = (
  match: string,
  // Regex capture groups, in order. A non-participating group is `undefined`,
  // which is why every callback treats these as `string | undefined`. (The
  // trailing offset/full-string args that `String.prototype.replace` also
  // passes are unused by every replacement here, so they are not modeled.)
  ...groups: (string | undefined)[]
) => string;

export type ReplacementValue = string | ReplacementFunction;

export interface ReplacementCategory {
  name: string;
  description: string;
  patterns: Record<string, ReplacementValue>;
  isRegex?: boolean;
  /** Regex flags such as 'g'; only consulted when isRegex is true. */
  flags?: string;
}
