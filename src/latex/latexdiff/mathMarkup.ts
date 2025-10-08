export const MATH_MARKUP_OPTIONS = ['off', 'whole', 'coarse', 'fine'] as const;

export type MathMarkupOption = (typeof MATH_MARKUP_OPTIONS)[number];

export const DEFAULT_MATH_MARKUP: MathMarkupOption = 'coarse';

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
