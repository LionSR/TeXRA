// Local imports
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { capitalize } from '@common/stringUtils.js';
import { createIcon, createFileListItem } from '@common/templateUtils.js';

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
    const toggleIcon = safeGetElementById(`toggle${capitalize(containerId)}`);
    if (!container || !toggleIcon) return;

    const fileElement = createFileListItem(file);
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
      toggleIcon.innerHTML = '';
      const iconEl = createIcon(CHEVRON_UP_CLASS);
      if (iconEl) toggleIcon.appendChild(iconEl);

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
    toggleIcon.innerHTML = '';
    const icon = createIcon(isVisible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS);
    if (icon) toggleIcon.appendChild(icon);
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
      toggleIconDiv.innerHTML = '';
      const icon = createIcon(CHEVRON_DOWN_CLASS);
      if (icon) toggleIconDiv.appendChild(icon);
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
