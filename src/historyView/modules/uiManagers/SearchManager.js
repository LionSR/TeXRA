// Local imports - history view
import { CLASS_NAMES, ELEMENT_IDS } from '../constants.js';
import { historyViewState } from '../historyViewState.js';
/* global Mark */
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Handles search functionality using mark.js.
 */
export class SearchManager {
  constructor(state = historyViewState) {
    this.state = state;
    this.markInstance = null;
    this.container = null;
  }

  initialize(container) {
    this.container = container;
    this.markInstance = new Mark(container);
  }

  search(term) {
    if (!this.markInstance) return;
    this.markInstance.unmark({
      done: () => {
        if (term) {
          this.state.setSearchIndex(-1);
          this.state.setTotalMatches(0);
          this.expandAllCollapsibleSections();
          let count = 0;
          this.markInstance.mark(term, {
            each: () => {
              count += 1;
            },
            done: () => {
              this.state.setTotalMatches(count);
              if (count > 0) {
                this.state.setSearchIndex(0);
                this.scrollToCurrentMatch();
              } else {
                this.state.setSearchIndex(-1);
                this.applySavedToggleStates();
                this.updateMatchCountDisplay();
              }
            },
          });
        } else {
          this.state.setSearchIndex(-1);
          this.state.setTotalMatches(0);
          this.updateMatchCountDisplay();
          this.applySavedToggleStates();
        }
      },
    });
  }

  navigateNext() {
    if (this.state.totalMatches === 0) return;
    const current = document.querySelector(`mark.${CLASS_NAMES.CURRENT_MATCH}`);
    if (current) current.classList.remove(CLASS_NAMES.CURRENT_MATCH);
    const nextIndex = (this.state.searchIndex + 1) % this.state.totalMatches;
    this.state.setSearchIndex(nextIndex);
    this.scrollToCurrentMatch();
  }

  navigatePrev() {
    if (this.state.totalMatches === 0) return;
    const current = document.querySelector(`mark.${CLASS_NAMES.CURRENT_MATCH}`);
    if (current) current.classList.remove(CLASS_NAMES.CURRENT_MATCH);
    const prevIndex =
      (this.state.searchIndex - 1 + this.state.totalMatches) %
      this.state.totalMatches;
    this.state.setSearchIndex(prevIndex);
    this.scrollToCurrentMatch();
  }

  scrollToCurrentMatch() {
    if (this.state.totalMatches === 0) return;
    const marks = document.querySelectorAll('mark');
    if (marks.length > this.state.searchIndex) {
      marks[this.state.searchIndex].classList.add(CLASS_NAMES.CURRENT_MATCH);
      marks[this.state.searchIndex].scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      this.updateMatchCountDisplay();
    }
  }

  updateMatchCountDisplay() {
    const el = safeGetElementById(ELEMENT_IDS.MATCH_COUNT);
    if (!el) return;
    const total = this.state.totalMatches;
    if (total === 0) {
      el.textContent = '';
    } else {
      el.textContent = `${this.state.searchIndex + 1}/${total}`;
    }
  }

  expandAllCollapsibleSections() {
    document
      .querySelectorAll(`.${CLASS_NAMES.HISTORY_COLLAPSIBLE}`)
      .forEach((section) => {
        if (!(section instanceof HTMLElement)) {
          return;
        }
        if ('open' in section) {
          section.open = true;
        }
        section.setAttribute('open', '');
      });
  }

  applySavedToggleStates() {
    document
      .querySelectorAll(`.${CLASS_NAMES.HISTORY_COLLAPSIBLE}`)
      .forEach((section) => {
        if (!(section instanceof HTMLElement)) {
          return;
        }
        const id = section.dataset.id;
        const expanded = this.state.toggleStates.get(id);
        if ('open' in section) {
          section.open = Boolean(expanded);
        }
        if (expanded) {
          section.setAttribute('open', '');
        } else {
          section.removeAttribute('open');
        }
      });
  }

  dispose() {
    if (this.markInstance) {
      this.markInstance.unmark();
    }
    this.markInstance = null;
    this.container = null;
  }
}
