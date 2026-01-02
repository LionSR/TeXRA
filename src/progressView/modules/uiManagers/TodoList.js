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
 */
export class TodoList {
  constructor() {
    this._elements = null;
    this._currentTodos = [];
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
   * @param {Array<{content: string, status: string, activeForm: string}>} todos - The todo items
   */
  update(todos) {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    this._currentTodos = todos || [];

    if (this._currentTodos.length === 0) {
      this.hide();
      return;
    }

    // Clear and rebuild the list
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
    const item = document.createElement('div');
    item.className = `todo-item ${STATUS_CLASSES[todo.status] || ''}`;

    const icon = document.createElement('i');
    let iconClass = STATUS_ICONS[todo.status];
    if (!iconClass) {
      console.warn(
        `[TodoList] Unknown todo status: "${todo.status}", using pending icon`,
      );
      iconClass = STATUS_ICONS[TODO_STATUS.PENDING];
    }
    // Add 'spin' as separate class for in-progress animation (codicon pattern)
    const spinClass = todo.status === TODO_STATUS.IN_PROGRESS ? ' spin' : '';
    icon.className = `codicon codicon-${iconClass}${spinClass} todo-item__icon`;
    item.appendChild(icon);

    const content = document.createElement('span');
    content.className = 'todo-item__content';
    content.textContent =
      todo.status === TODO_STATUS.IN_PROGRESS ? todo.activeForm : todo.content;
    item.appendChild(content);

    return item;
  }

  /**
   * Show the todo list container (vscode-collapsible).
   */
  show() {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    setVisibilityState(elements.container, true);
  }

  /**
   * Hide the todo list container (vscode-collapsible).
   */
  hide() {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    setVisibilityState(elements.container, false);
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
