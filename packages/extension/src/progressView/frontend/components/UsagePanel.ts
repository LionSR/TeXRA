// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared schemas
import type { TokenUsageStats, UsageRoute } from '@shared/schemas';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { clamp, formatCompactTokenCount } from '@utils/core';
import { formatCostUsd } from '@utils/text/stringUtils';

// Local imports - progress view
import { ELEMENT_IDS } from '../constants';
import type { ContextStateData } from '../store';

/**
 * Default compaction threshold (%) — must match
 * DEFAULT_COMPACTION_THRESHOLD_PERCENT in contextManagementConstants.ts.
 */
const COMPACTION_THRESHOLD = 75;

type UsageRouteBadge = {
  label: string;
  title: string;
};

/** Solid fill color based on context utilization. */
function fillColor(percent: number): string {
  if (percent <= 65) return 'var(--color-success)';
  if (percent <= 80) return 'var(--color-warning)';
  return 'var(--color-status-error)';
}

function usageRouteBadge(
  route: UsageRoute | undefined,
): UsageRouteBadge | undefined {
  switch (route) {
    case 'chatgpt-subscription':
      return {
        label: 'ChatGPT',
        title: 'No charge; covered by your ChatGPT subscription',
      };
    case 'relay':
      return {
        label: 'relay',
        title: 'Routed through the TeXRA relay',
      };
    case 'api-key':
      return {
        label: 'your key',
        title: 'Billed through your configured API key',
      };
    default:
      return undefined;
  }
}

function usageCostLabel(cost: number, route: UsageRoute | undefined): string {
  const badge = usageRouteBadge(route);
  if (!badge) return formatCostUsd(cost);
  if (route === 'chatgpt-subscription' && cost === 0) {
    return `Free via ${badge.label}`;
  }
  return `${formatCostUsd(cost)} via ${badge.label}`;
}

@customElement('usage-panel')
export class UsagePanel extends LitElement {
  static override styles = [
    designTokens,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .usage-summary-footer {
        border-top: var(--border-thin) solid var(--color-border);
        background-color: var(--wa-color-surface-lowered);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      :is(.run-summary, .context-state) {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        opacity: var(--opacity-normal);
      }

      :is(.run-summary, .context-state) wa-icon {
        font-size: var(--font-size-icon-sm);
        opacity: var(--opacity-subtle);
      }

      .run-summary__route {
        font-weight: var(--wa-font-weight-semibold);
      }

      .run-summary__route--free {
        color: var(--color-success);
      }

      /* Context gauge bar */
      .context-gauge {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .context-gauge__track {
        position: relative;
        width: 80px;
        height: 6px;
        background: var(--wa-color-surface-border);
        border-radius: var(--border-radius);
        overflow: hidden;
      }

      .context-gauge__fill {
        display: block;
        height: 100%;
        border-radius: var(--border-radius);
        transition: width var(--transition-slow);
      }

      /* Compaction threshold tick mark */
      .context-gauge__tick {
        position: absolute;
        top: 0;
        bottom: 0;
        width: var(--border-thin);
        background: var(--wa-color-text-normal);
        opacity: var(--opacity-separator);
      }

      .run-summary {
        margin-left: auto;
      }

      .run-summary__label {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      :is(.run-summary__value, .context-state__value) {
        color: var(--wa-color-text-normal);
      }
    `,
  ];

  @property({ attribute: false }) usage: TokenUsageStats | null = null;
  @property({ attribute: false }) contextState: ContextStateData | null = null;

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
    const cacheMiss = this.usage.cacheMissInputTokens ?? 0;
    const cacheWrite = this.usage.cacheCreationInputTokens ?? 0;

    return html`
      <wa-icon
        library=${TEXRA_ICON_LIBRARY}
        name="pie-chart"
        aria-hidden="true"
      ></wa-icon>
      <span class="run-summary__label">Total usage:</span>
      <span class="run-summary__value">
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="arrow-up"
          title="Input tokens"
          aria-hidden="true"
        ></wa-icon
        >${formatCompactTokenCount(inputTokens)}
        ${when(
          cacheRead > 0,
          () =>
            html` ·
              <wa-icon
                library=${TEXRA_ICON_LIBRARY}
                name="cloud-download"
                title="Cache read tokens (discounted)"
                aria-hidden="true"
              ></wa-icon>
              ${formatCompactTokenCount(cacheRead)}`,
        )}
        ${when(
          cacheMiss > 0,
          () =>
            html` ·
              <wa-icon
                library=${TEXRA_ICON_LIBRARY}
                name="cloud-upload"
                title="Cache miss tokens (full price)"
                aria-hidden="true"
              ></wa-icon>
              ${formatCompactTokenCount(cacheMiss)}`,
        )}
        ${when(
          cacheWrite > 0,
          () =>
            html` ·
              <wa-icon
                library=${TEXRA_ICON_LIBRARY}
                name="database"
                title="Cache creation tokens (1.25x cost)"
                aria-hidden="true"
              ></wa-icon>
              ${formatCompactTokenCount(cacheWrite)}`,
        )}
        ·
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="arrow-down"
          title="Output tokens"
          aria-hidden="true"
        ></wa-icon
        >${formatCompactTokenCount(outputTokens)} ·
        ${this.renderCostRoute(cost)}
      </span>
    `;
  }

  private renderCostRoute(cost: number): TemplateResult {
    const route = this.usage?.usageRoute;
    const badge = usageRouteBadge(route);
    if (!badge) return html`${formatCostUsd(cost)}`;

    if (route === 'chatgpt-subscription' && cost === 0) {
      return html`<span
        class="run-summary__route run-summary__route--free"
        title=${badge.title}
        >Free · ${badge.label}</span
      >`;
    }

    return html`${formatCostUsd(cost)} ·
      <span class="run-summary__route" title=${badge.title}>
        ${badge.label}
      </span>`;
  }

  private renderContext(): TemplateResult | typeof nothing {
    if (!this.contextState) return nothing;
    const { inputTokens, contextWindow, utilizationPercent } =
      this.contextState;
    const clamped = clamp(utilizationPercent, 0, 100);

    return html`
      <span class="context-gauge" title="${clamped.toFixed(0)}% context used">
        <wa-icon
          library=${TEXRA_ICON_LIBRARY}
          name="window"
          aria-hidden="true"
        ></wa-icon>
        <span class="context-gauge__track">
          <span
            class="context-gauge__fill"
            style=${styleMap({
              width: `${clamped}%`,
              backgroundColor: fillColor(clamped),
            })}
          ></span>
          <span
            class="context-gauge__tick"
            style=${styleMap({ left: `${COMPACTION_THRESHOLD}%` })}
            title="Compaction at ${COMPACTION_THRESHOLD}%"
          ></span>
        </span>
        <span class="context-state__value">
          ${formatCompactTokenCount(inputTokens)} /
          ${formatCompactTokenCount(contextWindow)}
        </span>
      </span>
    `;
  }

  private buildUsageLabel(): string {
    if (!this.usage) return '';
    const { inputTokens, outputTokens, cost } = this.usage;
    const costLabel = usageCostLabel(cost, this.usage.usageRoute);
    return `Total usage: ${formatCompactTokenCount(inputTokens)} input tokens, ${formatCompactTokenCount(outputTokens)} output tokens, ${costLabel}`;
  }
}
