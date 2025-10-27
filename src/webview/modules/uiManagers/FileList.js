// Local imports - webview
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Handles multi-file list DOM updates.
 */
export class FileList {
  constructor(saveFn = () => {}) {
    this._saveFn = saveFn;
    this._removeCallbacks = new Map();
    this._batchMode = false;
  }

  _getCollapsible(containerId, toggleId) {
    if (toggleId) {
      const toggleElement = safeGetElementById(toggleId);
      if (toggleElement) {
        return toggleElement;
      }
    }
    return safeGetElementById(`${containerId}Container`);
  }

  _setOpen(collapsible, isOpen, emitEvent = true) {
    if (!collapsible) {
      return;
    }
    const wasOpen = collapsible.hasAttribute('open');
    if (isOpen) {
      collapsible.setAttribute('open', '');
    } else {
      collapsible.removeAttribute('open');
    }
    if (emitEvent && wasOpen !== isOpen) {
      collapsible.dispatchEvent(new Event('toggle', { bubbles: true }));
    }
  }

  /** Set the callback used to persist state */
  setSaveFn(saveFn) {
    this._saveFn = typeof saveFn === 'function' ? saveFn : () => {};
  }

  /** Register a callback fired when entries are removed from a list */
  setRemoveCallback(containerId, callback) {
    if (!containerId) {
      return;
    }
    if (typeof callback === 'function') {
      this._removeCallbacks.set(containerId, callback);
    } else {
      this._removeCallbacks.delete(containerId);
    }
  }

  /** Save state unless in batch mode */
  _save() {
    if (!this._batchMode) {
      this._saveFn();
    }
  }
  /**
   * Add a file entry to a list container
   * @param {string} containerId - The list element ID
   * @param {string} file - The file path to add
   */
  add(containerId, file) {
    const container = safeGetElementById(containerId);
    const collapsible = this._getCollapsible(containerId);
    if (!container || !collapsible) return;

    const placeholder = container.querySelector('.file-list-placeholder');
    if (placeholder) {
      container.removeChild(placeholder);
    }

    const fileElement = createFromTemplate('fileListEntryTemplate', {
      text: { '.file-name': file },
      dataset: { '': { path: file } },
    });

    if (!fileElement) return;

    const removeButton = fileElement.querySelector('.remove-button');
    if (removeButton) {
      addEventListenerSafely(removeButton, 'click', () => {
        if (container.contains(fileElement)) {
          container.removeChild(fileElement);
        }

        const remaining = this.getSelected(container);
        const removeCallback = this._removeCallbacks.get(containerId);
        if (removeCallback) {
          removeCallback(remaining);
        }

        if (container.children.length === 0) {
          this.empty(containerId, undefined, false);
        } else {
          this._save();
        }
      });
    }
    container.appendChild(fileElement);
  }

  /** Update a multi-file list, showing the toggle when files exist */
  update(listId, toggleId, files) {
    const listDiv = safeGetElementById(listId);
    const collapsible = this._getCollapsible(listId, toggleId);
    if (!listDiv || !collapsible) return;

    const existing = this.getSelected(listDiv);
    const newFiles = files.filter((f) => !existing.includes(f));

    if (newFiles.length > 0) {
      this._batchMode = true;
      newFiles.forEach((file) => this.add(listId, file));
      this._batchMode = false;

      this._setOpen(collapsible, true);
    }
    this._save();
  }

  /** Return an array of selected file paths */
  getSelected(container) {
    const fileElements = container.querySelectorAll('.file-item');
    return Array.from(fileElements).map((el) => el.dataset.path || '');
  }

  /** Show or hide a file list container */
  setVisibility(containerId, toggleId, isVisible) {
    const collapsible = this._getCollapsible(containerId, toggleId);
    if (!collapsible) return;
    this._setOpen(collapsible, isVisible);
  }

  /** Toggle visibility of a file list container */
  toggle(containerId, toggleId) {
    const collapsible = this._getCollapsible(containerId, toggleId);
    if (!collapsible) return;
    const isVisible = collapsible.hasAttribute('open');
    this.setVisibility(containerId, toggleId, !isVisible);
    this._save();
  }

  /** Empty all files from a container and hide it */
  empty(containerId, toggleId, shouldSave = true) {
    const listDiv = safeGetElementById(containerId);
    const collapsible = this._getCollapsible(containerId, toggleId);
    if (!listDiv || !collapsible) return;

    listDiv.innerHTML = '';
    this._setOpen(collapsible, false);
    if (shouldSave) {
      this._save();
    }
  }

  /** Hide empty lists from the provided id array */
  hideEmpty(ids) {
    ids.forEach((id) => {
      const selectDiv = safeGetElementById(id);
      if (!selectDiv) return;
      if (selectDiv.children.length === 0) {
        this.setVisibility(id, undefined, false);
      }
    });
  }
}

export const fileList = new FileList();
