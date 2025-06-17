// Local imports - replacement utilities
import {
  applyReplacements,
  getAllReplacements,
  getAllReplacementsRegex,
} from './replacementUtils';

/**
 * Provides high-level APIs for applying text replacement rules.
 */
export const replacementManager = {
  /**
   * Apply all non-regex replacement rules.
   */
  applyNonRegex(text: string): string {
    return applyReplacements(text, getAllReplacements()).trim();
  },

  /**
   * Apply all regex-based replacement rules.
   */
  applyRegex(text: string): string {
    return applyReplacements(text, getAllReplacementsRegex()).trim();
  },

  /**
   * Apply the full set of replacement rules. Non-regex replacements are
   * executed before and after regex replacements to resolve any nested
   * transformations.
   */
  applyAll(text: string): string {
    let processed = this.applyNonRegex(text);
    processed = this.applyRegex(processed);
    return this.applyNonRegex(processed);
  },
};

export default replacementManager;
