export type ReplacementFunction = (
  match: string,
  ...args: (string | number | undefined)[]
) => string;

export type ReplacementValue = string | ReplacementFunction;

export interface ReplacementCategory {
  name: string;
  description: string;
  patterns: { [key: string]: ReplacementValue };
  isRegex?: boolean;
  flags?: string; // Optional regex flags
}
