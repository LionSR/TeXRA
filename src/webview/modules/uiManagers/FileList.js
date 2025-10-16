// Local imports - webview
import {
  addEventListenerSafely,
  safeGetElementById,
  setChevronIcon,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Handles multi-file list DOM updates.
 */
export class FileList {
  constructor(saveFn = () => {}) {
    this._saveFn = saveFn;
  }

  /**
   * Hydrate a list container with the provided files and visibility state.
   * @param {string} containerId - The list element ID
   * @param {object} options - Hydration options
   * @param {string[]} options.files - Files to render inside the list
   * @param {boolean} [options.visible] - Optional visibility override
   * @param {string} [options.placeholder] - Placeholder text when list is empty
   */
  hydrate(containerId, { files = [], visible, placeholder } = {}) {
    const listDiv = safeGetElementById(containerId);
    if (!listDiv) return;

    listDiv.innerHTML = '';

    if (Array.isArray(files) && files.length > 0) {
      files.forEach((file) => this.add(containerId, file));
    } else if (placeholder) {
      const placeholderEl = document.createElement('div');
      placeholderEl.className = 'file-list-placeholder';
      placeholderEl.textContent = placeholder;
      listDiv.appendChild(placeholderEl);
    }

    if (typeof visible === 'boolean') {
      const toggleId = `toggle${capitalize(containerId)}`;
      this.setVisibility(containerId, toggleId, visible);
    }
  }

  /** Set the callback used to persist state */
  setSaveFn(saveFn) {
    this._saveFn = typeof saveFn === 'function' ? saveFn : () => {};
  }
  /**
   * Add a file entry to a list container
   * @param {string} containerId - The list element ID
   * @param {string} file - The file path to add
   */
  add(containerId, file) {
    const container = safeGetElementById(containerId);
    const toggleIcon = safeGetElementById(`toggle${capitalize(containerId)}`);
    if (!container || !toggleIcon) return;

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
        if (container.children.length === 0) {
          this.empty(containerId, `toggle${capitalize(containerId)}`);
        }
        this._saveFn();
      });
    }
    container.appendChild(fileElement);
  }

  /** Update a multi-file list, showing the toggle when files exist */
  update(listId, toggleId, files) {
    const listDiv = safeGetElementById(listId);
    const toggleIcon = safeGetElementById(toggleId);
    if (!listDiv || !toggleIcon) return;

    const existing = this.getSelected(listDiv);
    const newFiles = files.filter((f) => !existing.includes(f));

    if (newFiles.length > 0) {
      newFiles.forEach((file) => this.add(listId, file));
      listDiv.style.display = 'block';
      setChevronIcon(toggleIcon, true);

      const container = safeGetElementById(`${listId}Container`);
      if (container) {
        container.style.display = 'block';
      }
    }
    this._saveFn();
  }

  /** Return an array of selected file paths */
  getSelected(container) {
    const fileElements = container.querySelectorAll('.file-item');
    return Array.from(fileElements).map((el) => el.dataset.path || '');
  }

  /** Show or hide a file list container */
  setVisibility(containerId, toggleId, isVisible) {
    const container = safeGetElementById(`${containerId}Container`);
    const toggleIcon = safeGetElementById(toggleId);
    if (!container || !toggleIcon) return;
    container.style.display = isVisible ? 'block' : 'none';
    setChevronIcon(toggleIcon, isVisible);
  }

  /** Toggle visibility of a file list container */
  toggle(containerId, toggleId) {
    const container = safeGetElementById(`${containerId}Container`);
    if (!container) return;
    const isVisible = container.style.display !== 'none';
    this.setVisibility(containerId, toggleId, !isVisible);
    this._saveFn();
  }

  /** Empty all files from a container and hide it */
  empty(containerId, toggleId) {
    const listDiv = safeGetElementById(containerId);
    const container = safeGetElementById(`${containerId}Container`);
    if (!listDiv || !container) return;

    listDiv.innerHTML = '';
    container.style.display = 'none';
    const toggleIconDiv = safeGetElementById(toggleId);
    if (toggleIconDiv) {
      setChevronIcon(toggleIconDiv, false);
    }
    this._saveFn();
  }

  /** Hide empty lists from the provided id array */
  hideEmpty(ids) {
    ids.forEach((id) => {
      const selectDiv = safeGetElementById(id);
      if (!selectDiv) return;
      const toggleId = `toggle${capitalize(id)}`;
      if (selectDiv.children.length === 0) {
        this.setVisibility(id, toggleId, false);
      }
    });
  }
}

export const fileList = new FileList();
