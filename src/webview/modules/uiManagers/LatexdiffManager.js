// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import { safeGetElementById, setChevronIcon } from '@common/domUtils.js';

const LATEXDIFF_CONTENT_ID = ELEMENT_IDS.LATEXDIFFS_CONTENT;
const TOGGLE_LATEXDIFFS_ID = ELEMENT_IDS.TOGGLE_LATEXDIFFS;

/**
 * Handles LaTeX diff section visibility.
 */
export class LatexdiffManager {
  constructor(state) {
    this.state = state;
  }

  /** Hydrate the LaTeX diffs section based on persisted state */
  hydrate(persistedState = this.state.get()) {
    const container = safeGetElementById(LATEXDIFF_CONTENT_ID);
    const toggleIcon = safeGetElementById(TOGGLE_LATEXDIFFS_ID);
    if (!container || !toggleIcon) return;

    const shouldShow = Boolean(persistedState?.latexdiffsVisible);
    container.style.display = shouldShow ? 'block' : 'none';
    setChevronIcon(toggleIcon, shouldShow);
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
mainViewState.registerLatexdiffManager(latexdiffManager);
