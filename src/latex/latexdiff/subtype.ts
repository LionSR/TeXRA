/**
 * Latexdiff subtype options.
 *
 * Subtypes control how changes are marked at the boundaries:
 * - SAFE: Default safe markup
 * - ONLYCHANGEDPAGE: Only show pages containing changes (ideal for proposals)
 * - ZLABEL: Requires post-processing, use latexdiff-vc --only-changes instead
 * - MARGIN: Shows changes in margin
 * - COLOR: Simple color-based marking
 * - DVIPSCOL: DVIPs color commands
 */
export const SUBTYPE_OPTIONS = [
  'SAFE',
  'ONLYCHANGEDPAGE',
  'COLOR',
  'MARGIN',
] as const;

export type SubtypeOption = (typeof SUBTYPE_OPTIONS)[number];

export const DEFAULT_SUBTYPE: SubtypeOption = 'SAFE';

const SUBTYPE_DESCRIPTIONS: Record<SubtypeOption, string> = {
  SAFE: 'Default - safe markup for all document types',
  ONLYCHANGEDPAGE: 'Only show pages containing changes (best for reviewing edits)',
  COLOR: 'Simple color-based change marking',
  MARGIN: 'Show change markers in margin',
};

export function describeSubtypeOption(option: SubtypeOption): string {
  return SUBTYPE_DESCRIPTIONS[option];
}
