export type ReplacementFunction = (
  match: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
) => string;

export type ReplacementValue = string | ReplacementFunction;

export interface ReplacementCategory {
  name: string;
  description: string;
  patterns: { [key: string]: ReplacementValue };
  isRegex?: boolean;
  flags?: string; // Optional regex flags
}
