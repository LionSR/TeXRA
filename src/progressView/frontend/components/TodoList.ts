// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports
import type { TodoItem } from '@shared/schemas';

@customElement('todo-list')
export class TodoList extends LitElement {
  @property({ type: Array }) todos: TodoItem[] = [];
  @property({ type: Boolean }) visible = false;

  createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult | null {
    const hasTodos = this.todos.length > 0;
    if (!this.visible || !hasTodos) return null;

    return html`
      <vscode-collapsible class="todo-collapsible" title="Tasks" open>
        <div class="todo-list" id="todoList">
          ${repeat(
            this.todos,
            (todo) => todo.content,
            (todo) => this.renderTodo(todo),
          )}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderTodo(todo: TodoItem): TemplateResult {
    const status = todo.status ?? 'pending';
    const icon = this.getStatusIcon(status);
    const text =
      status === 'in_progress'
        ? (todo.activeForm ?? todo.content)
        : todo.content;

    return html`
      <div
        class=${classMap({
          'todo-item': true,
          [`todo-item--${status}`]: true,
        })}
      >
        <i
          class=${classMap({
            codicon: true,
            [`codicon-${icon}`]: true,
            'todo-item__icon': true,
            spin: status === 'in_progress',
          })}
        ></i>
        <span class="todo-item__content">${text}</span>
      </div>
    `;
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'in_progress':
        return 'sync';
      case 'completed':
        return 'check';
      case 'pending':
      default:
        return 'circle-outline';
    }
  }
}
