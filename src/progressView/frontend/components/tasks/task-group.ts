// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { TaskGroup } from '@shared/schemas';

/**
 * Renders a task group entry.
 */
@customElement('task-group')
export class TaskGroupItem extends LitElement {
  @property({ type: Object })
  group!: TaskGroup;

  protected createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="log-entry">
        <div class="log-entry__meta">${this.group.status}</div>
        <div>${this.group.name}</div>
      </div>
    `;
  }
}
