// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';

// Reuse the production TodoList component with mock data so the demo
// reflects the real visual output, not a hand-rolled copy.
import '@progressView/frontend/components/TodoList';
import { TODO_STATUS, type TodoItem } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';

const SAMPLE_TODOS: TodoItem[] = [
  {
    status: TODO_STATUS.COMPLETED,
    content: 'Read base manuscript and extract section structure',
    activeForm: 'Reading base manuscript',
  },
  {
    status: TODO_STATUS.COMPLETED,
    content: 'Sketch reviewer-response outline per comment',
    activeForm: 'Sketching reviewer-response outline',
  },
  {
    status: TODO_STATUS.IN_PROGRESS,
    content: 'Draft revised abstract addressing reviewer #2',
    activeForm: 'Drafting revised abstract',
  },
  {
    status: TODO_STATUS.PENDING,
    content: 'Refine introduction with new positioning',
    activeForm: 'Refining introduction',
  },
  {
    status: TODO_STATUS.PENDING,
    content: 'Update bibliography with three new citations',
    activeForm: 'Updating bibliography',
  },
];

/**
 * Mock host for the production TodoList component, pre-populated with
 * sample data so screenshots show a realistic active checklist.
 */
@customElement('texra-todo-list-mock')
export class TodoListMock extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .frame {
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-m);
        padding: var(--wa-space-2xs) var(--wa-space-s);
        background: var(--wa-color-surface-default, transparent);
      }
    `,
  ];

  @state() private todos: TodoItem[] = SAMPLE_TODOS;
  @query('todo-list') private todoListEl?: HTMLElement;

  override async firstUpdated(): Promise<void> {
    // Production todo-list collapses by default; wait for its shadow DOM
    // to upgrade, then pre-open the inner wa-details so screenshots show
    // the checklist instead of the collapsed header.
    await customElements.whenDefined('todo-list');
    await customElements.whenDefined('wa-details');
    await Promise.resolve();
    const details =
      this.todoListEl?.shadowRoot?.querySelector('wa-details');
    if (details) (details as HTMLElement & { open: boolean }).open = true;
  }

  override render(): TemplateResult {
    return html`
      <div class="frame">
        <todo-list .todos=${this.todos}></todo-list>
      </div>
    `;
  }
}
