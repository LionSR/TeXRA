// Local imports - webview
import {
  addEventListenerSafely,
  safeGetElementById,
  setChevronIcon,
} from '@common/domUtils.js';
import { getFilesContainerId, getToggleId } from '@common/domIdUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Handles multi-file list DOM updates.
 */
export class FileList {
  constructor(saveFn = () => {}) {
    this._saveFn = saveFn;
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
    const toggleId = getToggleId(containerId);
    const toggleIcon = toggleId ? safeGetElementById(toggleId) : undefined;
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
        if (container.children.length === 0 && toggleId) {
          this.empty(containerId, toggleId);
        }
        this._saveFn();
      });
    }
    container.appendChild(fileElement);
  }

  /** Update a multi-file list, showing the toggle when files exist */
  update(listId, toggleId, files) {
    const listDiv = safeGetElementById(listId);
    const toggleIcon = toggleId ? safeGetElementById(toggleId) : undefined;
    if (!listDiv || !toggleIcon) return;

    const existing = this.getSelected(listDiv);
    const newFiles = files.filter((f) => !existing.includes(f));

    if (newFiles.length > 0) {
      newFiles.forEach((file) => this.add(listId, file));
      listDiv.style.display = 'block';
      setChevronIcon(toggleIcon, true);

      const containerId = getFilesContainerId(listId);
      const container = containerId ? safeGetElementById(containerId) : null;
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
    const containerIdStr = getFilesContainerId(containerId);
    const container = containerIdStr
      ? safeGetElementById(containerIdStr)
      : null;
    const toggleIcon = toggleId ? safeGetElementById(toggleId) : undefined;
    if (!container || !toggleIcon) return;
    container.style.display = isVisible ? 'block' : 'none';
    setChevronIcon(toggleIcon, isVisible);
  }

  /** Toggle visibility of a file list container */
  toggle(containerId, toggleId) {
    const containerIdStr = getFilesContainerId(containerId);
    const container = containerIdStr
      ? safeGetElementById(containerIdStr)
      : null;
    if (!container) return;
    const isVisible = container.style.display !== 'none';
    this.setVisibility(containerId, toggleId, !isVisible);
    this._saveFn();
  }

  /** Empty all files from a container and hide it */
  empty(containerId, toggleId) {
    const listDiv = safeGetElementById(containerId);
    const containerIdStr = getFilesContainerId(containerId);
    const container = containerIdStr
      ? safeGetElementById(containerIdStr)
      : null;
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
      const toggleId = getToggleId(id);
      if (toggleId && selectDiv.children.length === 0) {
        this.setVisibility(id, toggleId, false);
      }
    });
  }
}

export const fileList = new FileList();
