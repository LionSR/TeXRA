// Local imports
import { safeGetElementById } from '@common/domUtils.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { webviewState } from '../webviewState.js';

/**
 * Handles LaTeX diff section visibility.
 */
export class LatexdiffManager {
  constructor(state) {
    this.state = state;
  }

  /** Initialize the LaTeX diffs section based on stored state */
  initializeLatexdiffsSection() {
    const container = safeGetElementById('latexdiffsContent');
    const toggleIcon = safeGetElementById('toggleLatexdiffs');

    if (container && toggleIcon) {
      const state = this.state.get();
      const shouldShow = state && state.latexdiffsVisible;

      container.style.display = shouldShow ? 'block' : 'none';

      const iconElement = toggleIcon.querySelector('i');
      if (iconElement) {
        iconElement.className = shouldShow
          ? CHEVRON_UP_CLASS
          : CHEVRON_DOWN_CLASS;
      }
    }
  }

  /** Toggle the LaTeX diffs section */
  toggleLatexdiffs() {
    const container = safeGetElementById('latexdiffsContent');
    const toggleIcon = safeGetElementById('toggleLatexdiffs');
    if (!container || !toggleIcon) return;

    const isVisible = container.style.display !== 'none';
    container.style.display = isVisible ? 'none' : 'block';

    const iconElement = toggleIcon.querySelector('i');
    if (iconElement) {
      iconElement.className = isVisible ? CHEVRON_DOWN_CLASS : CHEVRON_UP_CLASS;
    }

    this.state.update({ latexdiffsVisible: !isVisible });
    this.state.save();
  }
}

export const latexdiffManager = new LatexdiffManager(webviewState);
