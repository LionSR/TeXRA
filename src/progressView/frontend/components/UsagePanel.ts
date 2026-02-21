// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - progress view
import { formatTokens } from '../formatters/timestampUtils';
import { ELEMENT_IDS } from '../constants';
import type { TokenUsageStats } from '@shared/schemas';
import type { ContextState } from '../store';

/**
 * Default compaction threshold (%) — must match
 * DEFAULT_COMPACTION_THRESHOLD_PERCENT in contextManagementConstants.ts.
 */
const COMPACTION_THRESHOLD = 75;

/**
 * Build a CSS gradient that transitions smoothly from green → amber → red
 * across the filled portion of the gauge, so the color shift feels gradual.
 */
function buildFillGradient(percent: number): string {
  const green = 'var(--vscode-testing-iconPassed, #73c991)';
  const amber = 'var(--vscode-editorWarning-foreground, #cca700)';
  const red = 'var(--vscode-testing-iconFailed, #f48771)';

  if (percent <= 50) return green;
  if (percent <= 65) return `linear-gradient(90deg, ${green}, ${amber})`;
  if (percent <= 80) return `linear-gradient(90deg, ${green} 20%, ${amber})`;
  return `linear-gradient(90deg, ${green} 10%, ${amber} 50%, ${red})`;
}

@customElement('usage-panel')
export class UsagePanel extends LitElement {
  static override styles = [
    designTokens,
    codiconIconClasses,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .usage-summary-footer {
        border-top: var(--border-thin) solid var(--color-border);
        background-color: var(--vscode-sideBarSectionHeader-background);
        padding: var(--spacing-small) var(--spacing-medium);
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      :is(.run-summary, .context-state) {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        opacity: var(--opacity-normal);
      }

      :is(.run-summary, .context-state) .codicon {
        font-size: var(--font-size-icon-sm);
        opacity: var(--opacity-subtle);
      }

      /* Context gauge bar */
      .context-gauge {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
      }

      .context-gauge__track {
        position: relative;
        width: 80px;
        height: 6px;
        background: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.3));
        border-radius: 3px;
        overflow: hidden;
      }

      .context-gauge__fill {
        height: 100%;
        border-radius: 3px;
        transition: width var(--transition-slow);
      }

      /* Compaction threshold tick mark */
      .context-gauge__tick {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--vscode-foreground);
        opacity: 0.35;
      }

      .run-summary {
        margin-left: auto;
      }

      .run-summary__label {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      :is(.run-summary__value, .context-state__value) {
        color: var(--vscode-foreground);
      }
    `,
  ];

  @property({ attribute: false }) usage: TokenUsageStats | null = null;
  @property({ attribute: false }) contextState: ContextState | null = null;

  /** Whether the usage stats have any non-zero values worth displaying. */
  private get hasUsage(): boolean {
    const u = this.usage;
    if (!u) return false;
    return (
      u.inputTokens > 0 ||
      u.outputTokens > 0 ||
      u.cost > 0 ||
      (u.cacheReadInputTokens ?? 0) > 0 ||
      (u.cacheCreationInputTokens ?? 0) > 0
    );
  }

  private get hasContext(): boolean {
    return (
      (this.contextState?.contextWindow ?? 0) > 0 &&
      this.contextState?.utilizationPercent !== undefined
    );
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.hasUsage && !this.hasContext) {
      return nothing;
    }

    return html`
      <div class="usage-summary-footer">
        <span
          id=${ELEMENT_IDS.CONTEXT_STATE}
          class="context-state"
          ?hidden=${!this.hasContext}
        >
          ${this.renderContext()}
        </span>
        <span
          id=${ELEMENT_IDS.RUN_SUMMARY}
          class="run-summary"
          aria-label=${this.buildUsageLabel()}
        >
          ${this.renderUsage()}
        </span>
      </div>
    `;
  }

  private renderUsage(): TemplateResult | typeof nothing {
    if (!this.usage) return nothing;

    const { inputTokens, outputTokens, cost } = this.usage;
    const cacheRead = this.usage.cacheReadInputTokens ?? 0;
    const cacheWrite = this.usage.cacheCreationInputTokens ?? 0;

    return html`
      <i class="codicon codicon-meter"></i>
      <span class="run-summary__label">Total usage:</span>
      <span class="run-summary__value">
        <i class="codicon codicon-arrow-up" title="Input tokens"></i
        >${formatTokens(inputTokens)}
        ${when(
          cacheRead > 0,
          () =>
            html` ·
              <i
                class="codicon codicon-cloud-download"
                title="Cache read tokens (discounted)"
              ></i>
              ${formatTokens(cacheRead)}`,
        )}
        ${when(
          cacheWrite > 0,
          () =>
            html` ·
              <i
                class="codicon codicon-database"
                title="Cache creation tokens (1.25x cost)"
              ></i>
              ${formatTokens(cacheWrite)}`,
        )}
        ·
        <i class="codicon codicon-arrow-down" title="Output tokens"></i
        >${formatTokens(outputTokens)} · $${cost.toFixed(3)}
      </span>
    `;
  }

  private renderContext(): TemplateResult | typeof nothing {
    if (!this.contextState) return nothing;
    const { inputTokens, contextWindow, utilizationPercent } =
      this.contextState;
    const clamped = Math.min(100, Math.max(0, utilizationPercent));

    return html`
      <span class="context-gauge" title="${clamped.toFixed(0)}% context used">
        <i class="codicon codicon-window"></i>
        <span class="context-gauge__track">
          <span
            class="context-gauge__fill"
            style="width: ${clamped}%; background: ${buildFillGradient(clamped)}"
          ></span>
          <span
            class="context-gauge__tick"
            style="left: ${COMPACTION_THRESHOLD}%"
            title="Compaction at ${COMPACTION_THRESHOLD}%"
          ></span>
        </span>
        <span class="context-state__value">
          ${formatTokens(inputTokens)} / ${formatTokens(contextWindow)}
        </span>
      </span>
    `;
  }

  private buildUsageLabel(): string {
    if (!this.usage) return '';
    const { inputTokens, outputTokens, cost } = this.usage;
    return `Total usage: ${formatTokens(inputTokens)} input tokens, ${formatTokens(outputTokens)} output tokens, $${cost.toFixed(3)}`;
  }
}
