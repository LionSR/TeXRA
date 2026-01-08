// Local imports - memory view
import { COMMANDS, ELEMENT_IDS, LABELS } from '../constants.js';
import { memoryViewState } from '../memoryViewState.js';
// Local imports - common helpers
import { clearElement, safeGetElementById } from '@common/domUtils.js';
import {
  formatBytes,
  formatLineCount,
  formatUpdatedDate,
} from '@common/stringUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Renders memory items and manages item markup.
 */
export class MemoryRenderer {
  constructor(state) {
    this.state = state;
  }

  /** Render list of memory items */
  render(items) {
    const list = safeGetElementById(ELEMENT_IDS.MEMORY_LIST);
    if (!list) return;

    const normalized = Array.isArray(items) ? items : [];
    this.state.setItems(normalized);
    clearElement(list);

    if (normalized.length === 0) {
      list.innerHTML = `<div class="empty-state">${LABELS.EMPTY_STATE}</div>`;
      return;
    }

    normalized.forEach((item) => {
      const element = this.createMemoryItem(item);
      if (element) {
        list.appendChild(element);
      }
    });
  }

  createMemoryItem(item) {
    const element = createFromTemplate('memoryItemTemplate', {
      text: {
        '.memory-path': item.displayPath,
        '.memory-meta': this.buildMeta(item),
      },
      attributes: {
        '.collapsible': { heading: LABELS.PREVIEW_HEADING },
      },
      dataset: {
        '.open-memory-btn': {
          command: COMMANDS.OPEN_MEMORY_FILE,
          storagePath: item.storagePath,
        },
        '.delete-memory-btn': {
          command: COMMANDS.DELETE_MEMORY,
          storagePath: item.storagePath,
          displayPath: item.displayPath,
        },
      },
    });

    if (!element) {
      return null;
    }

    const previewEl = element.querySelector('.memory-preview');
    if (previewEl) {
      const previewText = item.preview?.trim()
        ? item.preview
        : LABELS.EMPTY_PREVIEW;
      previewEl.textContent = previewText;
    }

    return element;
  }

  buildMeta(item) {
    const size = formatBytes(item.size ?? 0);
    const lines = formatLineCount(item.lineCount ?? 0);
    const updated = formatUpdatedDate(item.mtime);
    return [size, lines, updated].filter(Boolean).join(' · ');
  }
}

export const memoryRenderer = new MemoryRenderer(memoryViewState);
