// Third-party imports
import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register WA icon and spinner components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { TODO_STATUS, STATUS_ICONS, type TodoItem } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { ELEMENT_IDS } from '../constants';

// Local imports - base class
import { CollapsiblePanel } from './CollapsiblePanel';

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
        word-break: break-word;
      }

      .todo-item--pending {
        opacity: var(--opacity-subtle);
      }

      .todo-item--pending .todo-item__icon {
        color: var(--color-text-secondary);
      }

      .todo-item--in-progress {
        font-weight: var(--font-weight-medium);
      }

      .todo-item--in-progress .todo-item__icon {
        color: var(--wa-color-progress-bg);
      }

      .todo-item--completed {
        opacity: var(--opacity-disabled);
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

    return this.renderCollapsibleDetails({
      id: ELEMENT_IDS.TODO_LIST_CONTAINER,
      summary: `Todos (${completed}/${total})`,
      body: html`
        <div id=${ELEMENT_IDS.TODO_LIST} class="todo-list">
          ${repeat(
            this.todos,
            (_todo, index) => index,
            (todo) => this.renderTodo(todo),
          )}
        </div>
      `,
    });
  }

  private renderTodo(todo: TodoItem): TemplateResult {
    const status = todo.status;
    const isInProgress = status === TODO_STATUS.IN_PROGRESS;
    const icon = STATUS_ICONS[status];
    const content = isInProgress ? todo.activeForm : todo.content;

    return html`
      <div
        class=${classMap({
          'todo-item': true,
          'todo-item--pending': status === TODO_STATUS.PENDING,
          'todo-item--in-progress': status === TODO_STATUS.IN_PROGRESS,
          'todo-item--completed': status === TODO_STATUS.COMPLETED,
        })}
      >
        ${
          isInProgress
            ? html`<wa-spinner class="todo-item__icon"></wa-spinner>`
            : waIcon(icon, { className: 'todo-item__icon' })
        }
        <span class="todo-item__content">${content}</span>
      </div>
    `;
  }
}
