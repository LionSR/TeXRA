// Local imports - memory view
import { COMMANDS, ELEMENT_IDS, LABELS } from '../constants.js';
// Local imports - common
import { clearElement, safeGetElementById } from '@common/domUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

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
    const size = this.formatBytes(item.size ?? 0);
    const lines = this.formatLines(item.lineCount ?? 0);
    const updated = this.formatDate(item.mtime);
    return [size, lines, updated].filter(Boolean).join(' · ');
  }

  formatDate(value) {
    if (!value) {
      return 'Updated: unknown';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'Updated: unknown';
    }
    return `Updated ${DATE_FORMATTER.format(date)}`;
  }

  formatLines(count) {
    if (count === 1) {
      return '1 line';
    }
    return `${count} lines`;
  }

  formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }
}
