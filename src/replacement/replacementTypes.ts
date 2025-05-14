export interface ReplacementCategory {
  name: string;
  description: string;
  patterns: { [key: string]: string };
  isRegex?: boolean;
  flags?: string; // Optional regex flags
}
