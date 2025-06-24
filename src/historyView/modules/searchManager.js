/* global Mark */
import { safeGetElementById } from '@common/domUtils.js';
import { historyViewState } from './historyViewState.js';

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
                this.state.setSearchIndex(0);
                this.updateMatchCountDisplay();
              }
            },
          });
        } else {
          this.state.setSearchIndex(0);
          this.state.setTotalMatches(0);
          this.updateMatchCountDisplay();
        }
      },
    });
  }

  navigateNext() {
    if (this.state.totalMatches === 0) return;
    const current = document.querySelector('mark.current-match');
    if (current) current.classList.remove('current-match');
    const nextIndex = (this.state.searchIndex + 1) % this.state.totalMatches;
    this.state.setSearchIndex(nextIndex);
    this.scrollToCurrentMatch();
  }

  navigatePrev() {
    if (this.state.totalMatches === 0) return;
    const current = document.querySelector('mark.current-match');
    if (current) current.classList.remove('current-match');
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
      marks[this.state.searchIndex].classList.add('current-match');
      marks[this.state.searchIndex].scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      this.updateMatchCountDisplay();
    }
  }

  updateMatchCountDisplay() {
    const el = safeGetElementById('matchCount');
    if (!el) return;
    const total = this.state.totalMatches;
    if (total === 0) {
      el.textContent = '';
    } else {
      el.textContent = `${this.state.searchIndex + 1}/${total}`;
    }
  }

  expandAllCollapsibleSections() {
    document.querySelectorAll('.collapsible').forEach((section) => {
      if (!section.classList.contains('expanded')) {
        section.classList.add('expanded');
        const id = section.id.replace('content-', '');
        const toggle = document.querySelector(
          `.toggle-button[data-id="${id}"]`,
        );
        if (toggle) {
          toggle.textContent = 'Show less';
        }
        this.state.toggleStates.set(id, true);
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
