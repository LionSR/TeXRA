// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

// Local imports - shared helpers
import { safeGetElementById, setVisibilityState } from '@common/domUtils.js';
import { TODO_STATUS } from '@common/constants/todoStatus';

/**
 * Status icons for todo items.
 */
const STATUS_ICONS = {
  [TODO_STATUS.PENDING]: 'circle-outline',
  [TODO_STATUS.IN_PROGRESS]: 'loading',
  [TODO_STATUS.COMPLETED]: 'pass-filled',
};

/**
 * Status classes for styling.
 */
const STATUS_CLASSES = {
  [TODO_STATUS.PENDING]: 'todo-item--pending',
  [TODO_STATUS.IN_PROGRESS]: 'todo-item--in-progress',
  [TODO_STATUS.COMPLETED]: 'todo-item--completed',
};

/**
 * Manages the todo list display in the progress view.
 * Shows task progress for tool-use agents using native VS Code collapsible.
 * Uses surgical DOM updates when only status changes (common case).
 */
export class TodoList {
  constructor() {
    this._elements = null;
    this._currentTodos = [];
  }

  /**
   * Check if todos can be updated surgically (same items, only status changed).
   * @param {Array} oldTodos
   * @param {Array} newTodos
   * @returns {boolean}
   */
  _canUpdateInPlace(oldTodos, newTodos) {
    if (oldTodos.length !== newTodos.length) return false;
    for (let i = 0; i < oldTodos.length; i++) {
      if (oldTodos[i].content !== newTodos[i].content) return false;
    }
    return true;
  }

  /**
   * Update a single todo item's status in place.
   * @param {HTMLElement} item - The todo item element
   * @param {{content: string, status: string, activeForm: string}} todo
   */
  _updateItemStatus(item, todo) {
    const { status } = todo;
    const isInProgress = status === TODO_STATUS.IN_PROGRESS;

    // Update status class
    item.classList.remove(...Object.values(STATUS_CLASSES));
    if (STATUS_CLASSES[status]) item.classList.add(STATUS_CLASSES[status]);

    // Update icon
    const icon = item.querySelector('.todo-item__icon');
    if (icon) {
      icon.className = `codicon codicon-${STATUS_ICONS[status] ?? STATUS_ICONS[TODO_STATUS.PENDING]} todo-item__icon`;
      icon.classList.toggle('spin', isInProgress);
    }

    // Update text (activeForm vs content based on status)
    const content = item.querySelector('.todo-item__content');
    if (content) {
      content.textContent = isInProgress ? todo.activeForm : todo.content;
    }
  }

  /**
   * Lazily get DOM elements.
   * @returns {{container: HTMLElement, list: HTMLElement}|null}
   */
  _getElements() {
    if (!this._elements) {
      const container = safeGetElementById(ELEMENT_IDS.TODO_LIST_CONTAINER);
      const list = safeGetElementById(ELEMENT_IDS.TODO_LIST);

      if (!container || !list) {
        return null;
      }

      this._elements = { container, list };
    }

    return this._elements;
  }

  /**
   * Update the todo list display.
   * Uses surgical updates when only status changed (avoids full DOM rebuild).
   * @param {Array<{content: string, status: string, activeForm: string}>} todos - The todo items
   */
  update(todos) {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    const newTodos = todos ?? [];

    if (newTodos.length === 0) {
      this._currentTodos = [];
      this.hide();
      return;
    }

    // Fast path: same items, only status/activeForm may have changed
    // This is the common case during task execution
    if (this._canUpdateInPlace(this._currentTodos, newTodos)) {
      const items = elements.list.children;
      for (let i = 0; i < newTodos.length; i++) {
        // Only update if status actually changed
        if (this._currentTodos[i].status !== newTodos[i].status) {
          this._updateItemStatus(items[i], newTodos[i]);
        }
      }
      this._currentTodos = newTodos;
      return;
    }

    // Slow path: list structure changed, full rebuild required
    this._currentTodos = newTodos;
    elements.list.innerHTML = '';

    for (const todo of this._currentTodos) {
      const item = this._createTodoItem(todo);
      elements.list.appendChild(item);
    }

    this.show();
  }

  /**
   * Create a DOM element for a single todo item.
   * @param {{content: string, status: string, activeForm: string}} todo
   * @returns {HTMLElement}
   */
  _createTodoItem(todo) {
    const { status } = todo;
    const isInProgress = status === TODO_STATUS.IN_PROGRESS;

    const item = document.createElement('div');
    item.className = 'todo-item';
    if (STATUS_CLASSES[status]) item.classList.add(STATUS_CLASSES[status]);

    const icon = document.createElement('i');
    icon.className = `codicon codicon-${STATUS_ICONS[status] ?? STATUS_ICONS[TODO_STATUS.PENDING]} todo-item__icon`;
    if (isInProgress) icon.classList.add('spin');

    const content = document.createElement('span');
    content.className = 'todo-item__content';
    content.textContent = isInProgress ? todo.activeForm : todo.content;

    item.append(icon, content);
    return item;
  }

  /**
   * Set container visibility state.
   * @param {boolean} visible - Whether the container should be visible
   * @private
   */
  _setVisible(visible) {
    const elements = this._getElements();
    if (elements) {
      setVisibilityState(elements.container, visible);
    }
  }

  /**
   * Show the todo list container (vscode-collapsible).
   */
  show() {
    this._setVisible(true);
  }

  /**
   * Hide the todo list container (vscode-collapsible).
   */
  hide() {
    this._setVisible(false);
  }

  /**
   * Clear the todo list.
   */
  clear() {
    this._currentTodos = [];
    const elements = this._getElements();
    if (elements) {
      elements.list.innerHTML = '';
    }
    this.hide();
  }

  /**
   * Get the current todos.
   * @returns {Array<{content: string, status: string, activeForm: string}>}
   */
  getTodos() {
    return this._currentTodos;
  }
}
