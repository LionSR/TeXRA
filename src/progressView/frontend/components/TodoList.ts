// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - common
import { TODO_STATUS } from '@common/constants/todoStatus.js';

// Local types
import type { TodoItem } from '@shared/schemas';

const STATUS_ICONS: Record<string, string> = {
  [TODO_STATUS.PENDING]: 'circle-outline',
  [TODO_STATUS.IN_PROGRESS]: 'loading',
  [TODO_STATUS.COMPLETED]: 'pass-filled',
};

const STATUS_CLASSES: Record<string, string> = {
  [TODO_STATUS.PENDING]: 'todo-item--pending',
  [TODO_STATUS.IN_PROGRESS]: 'todo-item--in-progress',
  [TODO_STATUS.COMPLETED]: 'todo-item--completed',
};

@customElement('todo-list')
export class TodoList extends LitElement {
  @property({ type: Array }) todos: TodoItem[] = [];
  @property({ type: Boolean }) visible = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override render() {
    const shouldShow = this.visible && this.todos.length > 0;

    return html`
      <vscode-collapsible
        id="todoListContainer"
        class="todo-collapsible"
        title="Tasks"
        ?hidden=${!shouldShow}
      >
        <div class="todo-list" id="todoList">
          ${repeat(
            this.todos,
            (todo) => `${todo.status}-${todo.content}`,
            (todo) => {
              const statusClass = STATUS_CLASSES[todo.status] ?? '';
              const icon =
                STATUS_ICONS[todo.status] ?? STATUS_ICONS[TODO_STATUS.PENDING];
              const isInProgress = todo.status === TODO_STATUS.IN_PROGRESS;

              return html`
                <div class=${`todo-item ${statusClass}`}>
                  <i
                    class=${`codicon codicon-${icon} todo-item__icon ${
                      isInProgress ? 'spin' : ''
                    }`}
                  ></i>
                  <span class="todo-item__content">
                    ${isInProgress ? todo.activeForm : todo.content}
                  </span>
                </div>
              `;
            },
          )}
        </div>
      </vscode-collapsible>
      ${when(!shouldShow, () => html``)}
    `;
  }
}
