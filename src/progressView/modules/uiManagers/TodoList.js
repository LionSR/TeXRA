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

    this._currentTodos = todos ?? [];

    if (this._currentTodos.length === 0) {
      this.hide();
      return;
    }

    // Clear and rebuild the list using DocumentFragment
    elements.list.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const todo of this._currentTodos) {
      fragment.appendChild(this._createTodoItem(todo));
    }
    elements.list.appendChild(fragment);
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
