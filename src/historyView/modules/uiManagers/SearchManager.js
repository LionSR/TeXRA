// Local imports - history view
import { CLASS_NAMES, ELEMENT_IDS, LABELS } from '../constants.js';
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
      .querySelectorAll(`.${CLASS_NAMES.COLLAPSIBLE}`)
      .forEach((section) => {
        if (!section.classList.contains(CLASS_NAMES.EXPANDED)) {
          section.classList.add(CLASS_NAMES.EXPANDED);
          const id = section.id.replace('content-', '');
          const toggle = document.querySelector(
            `.${CLASS_NAMES.TOGGLE_BUTTON}[data-id="${id}"]`,
          );
          if (toggle) {
            toggle.textContent = LABELS.SHOW_LESS;
          }
        }
      });
  }

  applySavedToggleStates() {
    document
      .querySelectorAll(`.${CLASS_NAMES.COLLAPSIBLE}`)
      .forEach((section) => {
        const id = section.id.replace('content-', '');
        const expanded = this.state.toggleStates.get(id);
        const toggle = document.querySelector(
          `.${CLASS_NAMES.TOGGLE_BUTTON}[data-id="${id}"]`,
        );
        if (expanded) {
          section.classList.add(CLASS_NAMES.EXPANDED);
          if (toggle) toggle.textContent = LABELS.SHOW_LESS;
        } else {
          section.classList.remove(CLASS_NAMES.EXPANDED);
          if (toggle) toggle.textContent = LABELS.SHOW_MORE;
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
