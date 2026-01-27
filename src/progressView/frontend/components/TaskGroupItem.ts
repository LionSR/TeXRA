/**
 * Declarative task group item component.
 * Renders a single group with header and content slot.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - side effect: register component
import './TaskGroupHeader';

// Local imports - progress view constants
import { designTokens, commonViewStyles } from '@shared/styles';
import { GROUP_DOM_IDS } from '../constants';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - shared styles

// Local imports - shared schemas
import type { TaskGroup } from '@shared/schemas';

@customElement('task-group-item')
export class TaskGroupItem extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    ...logStyles,
    css`
      :host {
        display: contents;
      }
    `,
  ];

  @property({ type: Object }) group!: TaskGroup;
  @property({ type: Boolean }) expanded = true;

  private get isRoot(): boolean {
    return !this.group.parentGroupId;
  }

  private handleToggle(event: Event): void {
    const details = event.target as HTMLDetailsElement;
    this.dispatchEvent(
      new CustomEvent('group-toggle', {
        detail: { groupId: this.group.id, expanded: details.open },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): TemplateResult {
    const { group } = this;
    const contentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;
    const detailsId = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;

    // Root groups: simple container (no collapsible)
    if (this.isRoot) {
      return html`
        <div id=${detailsId} class="log-group log-run" data-run-id=${group.id}>
          <div id=${contentId} class="log-group-content">
            <slot></slot>
          </div>
        </div>
      `;
    }

    // Child groups: collapsible details element
    const headerId = `${GROUP_DOM_IDS.HEADER_PREFIX}${group.id}`;
    const headerClasses = {
      'log-group-header': true,
      [`is-${group.status}`]: true,
      'top-level': this.isRoot,
    };

    return html`
      <details
        id=${detailsId}
        class="log-group"
        ?open=${this.expanded}
        @toggle=${this.handleToggle}
      >
        <summary id=${headerId} class=${classMap(headerClasses)}>
          <task-group-header .group=${group}></task-group-header>
        </summary>
        <div id=${contentId} class="log-group-content">
          <slot></slot>
        </div>
      </details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'task-group-item': TaskGroupItem;
  }
}
