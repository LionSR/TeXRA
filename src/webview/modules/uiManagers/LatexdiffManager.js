// Local imports
import { safeGetElementById, setChevronIcon } from '@common/domUtils.js';
import { mainViewState } from '../mainViewState.js';
import { ELEMENT_IDS } from '../constants.js';

const LATEXDIFF_CONTENT_ID = ELEMENT_IDS.LATEXDIFFS_CONTENT;
const TOGGLE_LATEXDIFFS_ID = ELEMENT_IDS.TOGGLE_LATEXDIFFS;

/**
 * Handles LaTeX diff section visibility.
 */
export class LatexdiffManager {
  constructor(state) {
    this.state = state;
  }

  /** Initialize the LaTeX diffs section based on stored state */
  initializeLatexdiffsSection() {
    const container = safeGetElementById(LATEXDIFF_CONTENT_ID);
    const toggleIcon = safeGetElementById(TOGGLE_LATEXDIFFS_ID);

    if (container && toggleIcon) {
      const state = this.state.get();
      const shouldShow = state && state.latexdiffsVisible;

      container.style.display = shouldShow ? 'block' : 'none';
      setChevronIcon(toggleIcon, shouldShow);
    }
  }

  /** Toggle the LaTeX diffs section */
  toggleLatexdiffs() {
    const container = safeGetElementById(LATEXDIFF_CONTENT_ID);
    const toggleIcon = safeGetElementById(TOGGLE_LATEXDIFFS_ID);
    if (!container || !toggleIcon) return;

    const isVisible = container.style.display !== 'none';
    container.style.display = isVisible ? 'none' : 'block';
    setChevronIcon(toggleIcon, !isVisible);

    this.state.update({ latexdiffsVisible: !isVisible });
    this.state.save();
  }
}

export const latexdiffManager = new LatexdiffManager(mainViewState);
