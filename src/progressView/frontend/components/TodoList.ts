// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import { designTokens, animationStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared schemas
import { TODO_STATUS, type TodoItem } from '@shared/schemas';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

const STATUS_ICONS: Record<string, string> = {
  [TODO_STATUS.PENDING]: 'circle-outline',
  [TODO_STATUS.IN_PROGRESS]: 'loading',
  [TODO_STATUS.COMPLETED]: 'pass-filled',
};

@customElement('todo-list')
export class TodoList extends LitElement {
  static override styles = [
    designTokens,
    codiconIconClasses,
    animationStyles,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .todo-collapsible {
        margin: var(--spacing-small) 0;
        border-top: var(--border-thin) solid var(--color-border);
        border-bottom: var(--border-thin) solid var(--color-border);
      }

      .todo-collapsible::part(header) {
        padding: var(--spacing-small) var(--spacing-medium);
        background-color: var(
          --vscode-sideBarSectionHeader-background,
          transparent
        );
        color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
      }

      .todo-collapsible::part(body) {
        padding: 0 var(--spacing-medium) var(--spacing-small);
      }

      .todo-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-tiny);
      }

      .todo-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        font-size: var(--font-size);
        line-height: 1.4;
      }

      .todo-item__icon {
        flex-shrink: 0;
        font-size: var(--font-size-icon-sm);
        line-height: 1.4;
        margin-top: var(--border-thin);
      }

      .todo-item__content {
        flex: 1;
        word-break: break-word;
      }

      .todo-item--pending {
        opacity: 0.7;
      }

      .todo-item--pending .todo-item__icon {
        color: var(--color-text-secondary);
      }

      .todo-item--in-progress {
        font-weight: 500;
      }

      .todo-item--in-progress .todo-item__icon {
        color: var(--vscode-progressBar-background);
      }

      .todo-item--completed {
        opacity: 0.6;
      }

      .todo-item--completed .todo-item__icon {
        color: var(--color-success);
      }

      .todo-item--completed .todo-item__content {
        text-decoration: line-through var(--color-text-secondary);
      }
    `,
  ];

  @property({ type: Array }) todos: TodoItem[] = [];

  override render(): TemplateResult | typeof nothing {
    if (this.todos.length === 0) {
      return nothing;
    }

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.TODO_LIST_CONTAINER}
        class="todo-collapsible progress-collapsible"
        title="Task Progress"
        open
      >
        <div id=${ELEMENT_IDS.TODO_LIST} class="todo-list">
          ${repeat(
            this.todos,
            (todo, index) => `${index}-${todo.content}-${todo.status}`,
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
