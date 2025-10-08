export const MATH_MARKUP_OPTIONS = ['off', 'whole', 'coarse', 'fine'] as const;

export type MathMarkupOption = (typeof MATH_MARKUP_OPTIONS)[number];

export const DEFAULT_MATH_MARKUP: MathMarkupOption = 'coarse';

const MATH_MARKUP_OPTION_SET = new Set<string>(MATH_MARKUP_OPTIONS);

export function isMathMarkupOption(value: unknown): value is MathMarkupOption {
  return typeof value === 'string' && MATH_MARKUP_OPTION_SET.has(value);
}

export function normalizeMathMarkup(configured?: string): MathMarkupOption {
  return isMathMarkupOption(configured) ? configured : DEFAULT_MATH_MARKUP;
}

export function describeMathMarkupOption(option: MathMarkupOption): string {
  switch (option) {
    case 'coarse':
      return 'Default - recommended for most documents';
    case 'fine':
      return 'Detailed math markup';
    case 'whole':
      return 'Mark entire math environments';
    case 'off':
    default:
      return 'No math markup';
  }
}
