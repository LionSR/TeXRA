// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import {
  safeGetElementById,
  setChevronIcon,
  setExpandedState,
} from '@common/domUtils.js';

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
      setExpandedState(container, '.latexdiffs-section', shouldShow);
    }
  }

  /** Toggle the LaTeX diffs section */
  toggleLatexdiffs() {
    const container = safeGetElementById(LATEXDIFF_CONTENT_ID);
    const toggleIcon = safeGetElementById(TOGGLE_LATEXDIFFS_ID);
    if (!container || !toggleIcon) return;

    const isVisible = container.style.display !== 'none';
    const newVisible = !isVisible;
    container.style.display = newVisible ? 'block' : 'none';
    setChevronIcon(toggleIcon, newVisible);
    setExpandedState(container, '.latexdiffs-section', newVisible);

    this.state.update({ latexdiffsVisible: newVisible });
    this.state.save();
  }
}

export const latexdiffManager = new LatexdiffManager(mainViewState);
