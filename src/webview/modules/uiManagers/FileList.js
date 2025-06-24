// Local imports
import { webviewState } from '../webviewState.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { capitalize } from '@common/stringUtils.js';

/**
 * Handles multi-file list DOM updates.
 */
export class FileList {
  /**
   * Add a file entry to a list container
   * @param {string} containerId - ID of the list element
   * @param {string} file - File path to add
   */
  add(containerId, file) {
    const container = safeGetElementById(containerId);
    const toggleIcon = safeGetElementById(`toggle${capitalize(containerId)}`);
    if (!container || !toggleIcon) return;

    const fileElement = document.createElement('div');
    fileElement.className = 'file-item';
    fileElement.dataset.path = file;
    fileElement.innerHTML = `${file} <span class="remove-button">-</span>`;

    const removeButton = fileElement.querySelector('.remove-button');
    if (removeButton) {
      addEventListenerSafely(removeButton, 'click', () => {
        if (container.contains(fileElement)) {
          container.removeChild(fileElement);
          if (container.children.length === 0) {
            this.empty(containerId, `toggle${capitalize(containerId)}`);
          }
          webviewState.save();
        }
      });
    }
    container.appendChild(fileElement);
  }

  /**
   * Update a multi-file list, showing the toggle when files exist
   * @param {string} listId - ID of the list element
   * @param {string} toggleId - ID of the toggle icon element
   * @param {string[]} files - Files to display
   */
  update(listId, toggleId, files) {
    const listDiv = safeGetElementById(listId);
    const toggleIcon = safeGetElementById(toggleId);
    if (!listDiv || !toggleIcon) return;

    const existing = this.getSelected(listDiv);
    const newFiles = files.filter((f) => !existing.includes(f));

    if (newFiles.length > 0) {
      newFiles.forEach((file) => this.add(listId, file));
      listDiv.style.display = 'block';
      toggleIcon.innerHTML = `<i class="${CHEVRON_UP_CLASS}"></i>`;

      const container = safeGetElementById(`${listId}Container`);
      if (container) {
        container.style.display = 'block';
      }
    }
    webviewState.save();
  }

  /**
   * Return an array of selected file paths
   * @param {HTMLElement} container - Container element
   * @returns {string[]}
   */
  getSelected(container) {
    const fileElements = container.querySelectorAll('.file-item');
    return Array.from(fileElements).map((el) => el.dataset.path || '');
  }

  /**
   * Show or hide a file list container
   * @param {string} containerId - Base ID of the container
   * @param {string} toggleId - ID of the toggle icon element
   * @param {boolean} isVisible - Whether the container should be visible
   */
  setVisibility(containerId, toggleId, isVisible) {
    const container = safeGetElementById(`${containerId}Container`);
    const toggleIcon = safeGetElementById(toggleId);
    if (!container || !toggleIcon) return;
    container.style.display = isVisible ? 'block' : 'none';
    toggleIcon.innerHTML = `<i class="${
      isVisible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
    }"></i>`;
  }

  /**
   * Toggle visibility of a file list container
   * @param {string} containerId - Base ID of the container
   * @param {string} toggleId - ID of the toggle icon element
   */
  toggle(containerId, toggleId) {
    const container = safeGetElementById(`${containerId}Container`);
    if (!container) return;
    const isVisible = container.style.display !== 'none';
    this.setVisibility(containerId, toggleId, !isVisible);
    webviewState.save();
  }

  /**
   * Empty all files from a container and hide it
   * @param {string} containerId - Base ID of the container
   * @param {string} toggleId - ID of the toggle icon element
   */
  empty(containerId, toggleId) {
    const listDiv = safeGetElementById(containerId);
    const container = safeGetElementById(`${containerId}Container`);
    if (!listDiv || !container) return;

    listDiv.innerHTML = '';
    container.style.display = 'none';
    const toggleIconDiv = safeGetElementById(toggleId);
    if (toggleIconDiv) {
      toggleIconDiv.innerHTML = `<i class="${CHEVRON_DOWN_CLASS}"></i>`;
    }
    webviewState.save();
  }

  /**
   * Hide empty lists from the provided id array
   * @param {string[]} ids - IDs of list elements
   */
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
