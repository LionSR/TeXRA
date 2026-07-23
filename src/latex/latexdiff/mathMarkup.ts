export const MATH_MARKUP_OPTIONS = Object.freeze([
  'off',
  'whole',
  'coarse',
  'fine',
] as const);

export type MathMarkupOption = (typeof MATH_MARKUP_OPTIONS)[number];

export const DEFAULT_MATH_MARKUP: MathMarkupOption = 'coarse';

const MATH_MARKUP_DESCRIPTIONS: Record<MathMarkupOption, string> = {
  off: 'No math markup',
  whole: 'Mark entire math environments',
  coarse: 'Default - recommended for most documents',
  fine: 'Detailed math markup',
};

export function describeMathMarkupOption(option: MathMarkupOption): string {
  return MATH_MARKUP_DESCRIPTIONS[option];
}
