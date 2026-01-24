// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { TodoItem } from '@shared/schemas';

/**
 * Renders the todo list for a stream.
 */
@customElement('todo-list')
export class TodoList extends LitElement {
  @property({ type: Array })
  todos: TodoItem[] = [];

  protected createRenderRoot() {
    return this;
  }

  render() {
    if (!this.todos.length) {
      return html`<div class="empty-state">No todos yet.</div>`;
    }

    return html`
      <div class="todo-list">
        ${this.todos.map(
          (todo) => html`
            <div class="todo-item">
              <span>${todo.content}</span>
              <span>${todo.status}</span>
            </div>
          `,
        )}
      </div>
    `;
  }
}
