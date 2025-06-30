// Local imports
import { safeGetElementById } from '@common/domUtils.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { mainViewState } from '../mainViewState.js';

const LATEXDIFF_CONTENT_ID = 'latexdiffsContent';
const TOGGLE_LATEXDIFFS_ID = 'toggleLatexdiffs';
const ICON_SELECTOR = 'i';

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

      const iconElement = toggleIcon.querySelector(ICON_SELECTOR);
      if (iconElement) {
        iconElement.className = shouldShow
          ? CHEVRON_UP_CLASS
          : CHEVRON_DOWN_CLASS;
      }
    }
  }

  /** Toggle the LaTeX diffs section */
  toggleLatexdiffs() {
    const container = safeGetElementById(LATEXDIFF_CONTENT_ID);
    const toggleIcon = safeGetElementById(TOGGLE_LATEXDIFFS_ID);
    if (!container || !toggleIcon) return;

    const isVisible = container.style.display !== 'none';
    container.style.display = isVisible ? 'none' : 'block';

    const iconElement = toggleIcon.querySelector(ICON_SELECTOR);
    if (iconElement) {
      iconElement.className = isVisible ? CHEVRON_DOWN_CLASS : CHEVRON_UP_CLASS;
    }

    this.state.update({ latexdiffsVisible: !isVisible });
    this.state.save();
  }
}

export const latexdiffManager = new LatexdiffManager(mainViewState);
