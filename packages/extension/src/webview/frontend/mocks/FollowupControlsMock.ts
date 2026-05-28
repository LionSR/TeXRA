// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';

// Reuse the production followup component so the mock reflects the real
// affordance instead of inventing one. The wrapper just feeds it static
// FollowupOptionsState (agents + models) and a READY-status fixture.
// Side-effect imports - production progress view components
import '@progressView/frontend/components/WorkflowToolUseFollowupSection';

// Local imports - progress view types and shared styles
import type { FollowupOptionsState } from '@progressView/frontend/store';
import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';

const SAMPLE_OPTIONS: FollowupOptionsState = {
  toolUseAgentsData: [
    {
      value: 'tooluse-research',
      label: 'tooluse-research',
      description: 'Interactive research over the workflow outputs',
      isToolUse: true,
    },
    {
      value: 'tooluse-revise',
      label: 'tooluse-revise',
      description: 'Iteratively revise the revised files',
      isToolUse: true,
    },
    {
      value: 'tooluse-explain',
      label: 'tooluse-explain',
      description: 'Walk through what changed and why',
      isToolUse: true,
    },
  ],
  modelOptionsData: [
    {
      value: 'claude-opus-4-7',
      label: 'Claude Opus 4.7',
      provider: 'Anthropic',
      context: '1M',
    },
    {
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      provider: 'Anthropic',
      context: '200k',
    },
    {
      value: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      provider: 'Anthropic',
      context: '200k',
    },
  ],
};

const SAMPLE_STATUS: StreamStatus = STREAM_STATUS.READY;
const SAMPLE_STREAM_MODEL = 'claude-opus-4-7';

/**
 * Static host for the production WorkflowToolUseFollowupSection. Feeds it
 * a READY status, output-files=true, and a realistic options fixture so
 * the panel renders fully expanded for screenshots.
 */
@customElement('texra-followup-controls-mock')
export class FollowupControlsMock extends LitElement {
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
        padding: var(--wa-space-s);
        background: var(--wa-color-surface-default, transparent);
      }
    `,
  ];

  @state() private options: FollowupOptionsState = SAMPLE_OPTIONS;
  @query('workflow-tool-use-followup-section')
  private followupEl?: HTMLElement;

  override async firstUpdated(): Promise<void> {
    // Wait for the production component + wa-details to upgrade before
    // forcing the panel open; otherwise the query runs before the shadow
    // DOM exists and the section stays collapsed in screenshots.
    await customElements.whenDefined('workflow-tool-use-followup-section');
    await customElements.whenDefined('wa-details');
    await Promise.resolve();
    const details = this.followupEl?.shadowRoot?.querySelector('wa-details');
    if (details) (details as HTMLElement & { open: boolean }).open = true;
  }

  override render(): TemplateResult {
    return html`
      <div class="frame">
        <workflow-tool-use-followup-section
          .status=${SAMPLE_STATUS}
          .hasOutputFiles=${true}
          .options=${this.options}
          .streamModel=${SAMPLE_STREAM_MODEL}
        ></workflow-tool-use-followup-section>
      </div>
    `;
  }
}
