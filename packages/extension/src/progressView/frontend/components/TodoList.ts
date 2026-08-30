// Third-party imports
import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register WA icon and spinner components
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { TODO_STATUS, STATUS_ICONS, type TodoItem } from '@shared/schemas';
import { stopSpinnerMotion } from '@shared/wa/spinner';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { ELEMENT_IDS } from '../constants';

// Local imports - base class
import { CollapsiblePanel } from './CollapsiblePanel';

const TODO_STATUS_LABELS: Readonly<Record<TodoItem['status'], string>> = {
  [TODO_STATUS.PENDING]: 'Pending',
  [TODO_STATUS.IN_PROGRESS]: 'In progress',
  [TODO_STATUS.COMPLETED]: 'Completed',
};

@customElement('todo-list')
export class TodoList extends CollapsiblePanel {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .todo-list {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .todo-item {
        display: flex;
        align-items: flex-start;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-3xs) 0;
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
      }

      .todo-item__icon {
        flex-shrink: 0;
        font-size: var(--font-size-icon-sm);
        line-height: var(--line-height-normal);
        margin-top: var(--border-thin);
      }

      .todo-item__content {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .todo-item--pending {
        color: var(--color-text-secondary);
      }

      .todo-item--pending .todo-item__icon {
        color: var(--color-text-muted);
      }

      .todo-item--in-progress {
        font-weight: var(--font-weight-medium);
      }

      .todo-item--in-progress .todo-item__icon {
        color: var(--color-pending);
      }

      .todo-item--completed {
        color: var(--color-text-secondary);
      }

      .todo-item--completed .todo-item__icon {
        color: var(--color-success);
      }

      .todo-item--completed .todo-item__content {
        text-decoration: line-through var(--color-text-secondary);
      }
    `,
  ];

  @property({ attribute: false }) todos: TodoItem[] = [];

  override render(): TemplateResult | typeof nothing {
    if (this.todos.length === 0) {
      return nothing;
    }

    const completed = this.todos.filter(
      (t) => t.status === TODO_STATUS.COMPLETED,
    ).length;
    const total = this.todos.length;
    const activeTodo = this.todos.find(
      (todo) => todo.status === TODO_STATUS.IN_PROGRESS,
    );
    const progressText = `${completed} of ${total} ${total === 1 ? 'task' : 'tasks'} complete`;

    return html`
      <div class="visually-hidden" role="status">
        ${progressText}.${
          activeTodo ? ` In progress: ${activeTodo.activeForm}.` : nothing
        }
      </div>
      ${this.renderCollapsibleDetails({
        id: ELEMENT_IDS.TODO_LIST_CONTAINER,
        summary: `Tasks (${completed} of ${total} complete)`,
        body: html`
          <ol id=${ELEMENT_IDS.TODO_LIST} class="todo-list" aria-label="Tasks">
            ${repeat(
              this.todos,
              (_todo, index) => index,
              (todo) => this.renderTodo(todo),
            )}
          </ol>
        `,
      })}
    `;
  }

  private renderTodo(todo: TodoItem): TemplateResult {
    const status = todo.status;
    const isInProgress = status === TODO_STATUS.IN_PROGRESS;
    const icon = STATUS_ICONS[status];
    const content = isInProgress ? todo.activeForm : todo.content;

    return html`
      <li
        class=${classMap({
          'todo-item': true,
          'todo-item--pending': status === TODO_STATUS.PENDING,
          'todo-item--in-progress': status === TODO_STATUS.IN_PROGRESS,
          'todo-item--completed': status === TODO_STATUS.COMPLETED,
        })}
        aria-current=${isInProgress ? 'step' : nothing}
      >
        ${
          isInProgress
            ? html`<wa-spinner
                class="todo-item__icon"
                ${stopSpinnerMotion()}
              ></wa-spinner>`
            : waIcon(icon, { className: 'todo-item__icon' })
        }
        <span class="visually-hidden">${TODO_STATUS_LABELS[status]}: </span>
        <bdi class="todo-item__content">${content}</bdi>
      </li>
    `;
  }
}
