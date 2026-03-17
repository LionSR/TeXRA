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

      .todo-collapsible::part(body) {
        max-height: var(--height-xlarge);
        overflow-y: auto;
      }

      .todo-summary {
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
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

      .todo-item__number {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
        min-width: 1.4em;
        text-align: right;
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
        margin-top: var(--border-thin);
      }

      .todo-item__icon {
        flex-shrink: 0;
        font-size: var(--font-size-icon-sm);
        line-height: var(--line-height-normal);
        margin-top: var(--border-thin);
      }

      .todo-item__body {
        flex: 1;
        min-width: 0;
      }

      .todo-item__content {
        word-break: break-word;
      }

      .todo-item__description {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        margin-top: var(--spacing-tiny);
        word-break: break-word;
      }

      .todo-item__files {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-tiny);
        margin-top: var(--spacing-small);
      }

      .todo-item__file {
        font-size: var(--font-size-sm);
        color: var(--vscode-textLink-foreground);
        background: var(--vscode-badge-background);
        padding: var(--border-thin) var(--spacing-medium);
        border-radius: var(--border-radius);
        font-family: var(--vscode-editor-font-family, monospace);
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
        color: var(--vscode-progressBar-background);
      }

      .todo-item--in-progress .todo-item__content {
        color: var(--vscode-progressBar-background);
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
  @property({ attribute: false }) summary: string | null = null;

  /** Open state — auto-expands on todo updates, auto-collapses when cleared. */
  @state() private open = true;

  /** Whether any item has rich metadata (description or files). */
  private get isRichMode(): boolean {
    return this.todos.some((t) => t.description || (t.files && t.files.length > 0));
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('todos')) {
      if (this.todos.length > 0) {
        this.open = true;
      } else {
        this.open = false;
      }
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
    const title = this.summary ? `Plan (${completed}/${total})` : `Todos (${completed}/${total})`;

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.TODO_LIST_CONTAINER}
        class="todo-collapsible panel-collapsible"
        title=${title}
        ?open=${this.open}
        @vsc-collapsible-toggle=${this.handleCollapsibleToggle}
      >
        ${this.summary
          ? html`<div class="todo-summary">${this.summary}</div>`
          : nothing}
        <div id=${ELEMENT_IDS.TODO_LIST} class="todo-list">
          ${repeat(
            this.todos,
            (_todo, index) => index,
            (todo, index) => this.renderTodo(todo, index),
          )}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderTodo(todo: TodoItem, index: number): TemplateResult {
    const status = todo.status ?? TODO_STATUS.PENDING;
    const isInProgress = status === TODO_STATUS.IN_PROGRESS;
    const icon = STATUS_ICONS[status] ?? STATUS_ICONS[TODO_STATUS.PENDING];
    const isRich = this.isRichMode;

    // In simple mode, show activeForm when in progress
    const displayContent = isInProgress && !isRich
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
        ${isRich
          ? html`<span class="todo-item__number">${index + 1}.</span>`
          : nothing}
        <i
          class=${classMap({
            codicon: true,
            [`codicon-${icon}`]: true,
            'todo-item__icon': true,
            spin: isInProgress,
          })}
        ></i>
        <div class="todo-item__body">
          <div class="todo-item__content">${displayContent}</div>
          ${todo.description
            ? html`<div class="todo-item__description">${todo.description}</div>`
            : nothing}
          ${todo.files && todo.files.length > 0
            ? html`
                <div class="todo-item__files">
                  ${todo.files.map(
                    (file) =>
                      html`<span class="todo-item__file">${file}</span>`,
                  )}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private handleCollapsibleToggle(e: CustomEvent<{ open?: boolean }>): void {
    this.open = e.detail?.open ?? this.open;
  }
}
