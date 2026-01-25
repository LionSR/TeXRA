// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - shared schemas
import type { TodoItem } from '@shared/schemas';

// Local imports - common constants
import { TODO_STATUS } from '@common/constants/todoStatus';

const STATUS_ICONS: Record<string, string> = {
  [TODO_STATUS.PENDING]: 'circle-outline',
  [TODO_STATUS.IN_PROGRESS]: 'loading',
  [TODO_STATUS.COMPLETED]: 'pass-filled',
};

@customElement('todo-list')
export class TodoList extends LitElement {
  @property({ type: Array }) todos: TodoItem[] = [];

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    const visible = this.todos.length > 0;
    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.TODO_LIST_CONTAINER}
        class="todo-collapsible progress-collapsible"
        title="Todos"
        ?open=${visible}
        ?hidden=${!visible}
        aria-hidden=${visible ? 'false' : 'true'}
      >
        <div id=${ELEMENT_IDS.TODO_LIST} class="todo-list">
          ${repeat(
            this.todos,
            (todo) => `${todo.content}-${todo.status}`,
            (todo) => this.renderTodo(todo),
          )}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderTodo(todo: TodoItem): TemplateResult {
    const status = todo.status ?? TODO_STATUS.PENDING;
    const isInProgress = status === TODO_STATUS.IN_PROGRESS;
    const icon = STATUS_ICONS[status] ?? STATUS_ICONS[TODO_STATUS.PENDING];
    const content = isInProgress
      ? (todo.activeForm ?? todo.content)
      : todo.content;

    return html`
      <div
        class=${classMap({
          'todo-item': true,
          'todo-item--pending': status === TODO_STATUS.PENDING,
          'todo-item--in-progress': status === TODO_STATUS.IN_PROGRESS,
          'todo-item--completed': status === TODO_STATUS.COMPLETED,
        })}
      >
        <i
          class=${classMap({
            codicon: true,
            [`codicon-${icon}`]: true,
            'todo-item__icon': true,
            spin: isInProgress,
          })}
        ></i>
        <span class="todo-item__content">${content}</span>
      </div>
    `;
  }
}
