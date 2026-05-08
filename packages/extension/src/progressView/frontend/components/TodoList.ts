// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import {
  designTokens,
  animationStyles,
  commonViewStyles,
} from '@shared/styles';
import { TODO_STATUS, STATUS_ICONS, type TodoItem } from '@shared/schemas';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

import { ELEMENT_IDS } from '../constants';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

@customElement('todo-list')
export class TodoList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    animationStyles,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      /* Add bottom border */
      .todo-collapsible {
        border-bottom: var(--border-thin) solid var(--color-border);
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
        color: var(--texra-progressBar-background);
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

  /** When this key changes, the panel collapses. Used by the parent to reset
   *  open state on context switches (e.g. switching streams). */
  @property({ type: String }) collapseKey = '';

  @state() private open = false;

  protected override willUpdate(changed: PropertyValues): void {
    if (
      changed.has('collapseKey') &&
      changed.get('collapseKey') !== undefined
    ) {
      this.open = false;
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (this.todos.length === 0) {
      return nothing;
    }

    const completed = this.todos.filter(
      (t) => t.status === TODO_STATUS.COMPLETED,
    ).length;
    const total = this.todos.length;

    return html`
      <wa-details
        id=${ELEMENT_IDS.TODO_LIST_CONTAINER}
        class="todo-collapsible panel-collapsible"
        summary=${`Todos (${completed}/${total})`}
        ?open=${this.open}
        @wa-show=${this.handleShow}
        @wa-hide=${this.handleHide}
      >
        <div id=${ELEMENT_IDS.TODO_LIST} class="todo-list">
          ${repeat(
            this.todos,
            (_todo, index) => index,
            (todo) => this.renderTodo(todo),
          )}
        </div>
      </wa-details>
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

  private handleShow(e: Event): void {
    // Ignore bubbled events from nested wa-details
    if (e.target !== e.currentTarget) return;
    this.open = true;
  }

  private handleHide(e: Event): void {
    if (e.target !== e.currentTarget) return;
    this.open = false;
  }
}
