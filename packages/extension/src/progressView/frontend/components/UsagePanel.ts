// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { join } from 'lit/directives/join.js';
import { styleMap } from 'lit/directives/style-map.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared schemas
import type { TokenUsageStats, UsageRoute } from '@shared/schemas';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
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
  subscription: boolean;
};

/** One token counter in the usage strip: icon, count, and its tooltip. */
type TokenStat = {
  icon: TeXRAIconName;
  id: string;
  value: number;
  tooltip: string;
  /** Cache counters are hidden when the run never touched the cache. */
  onlyWhenPositive?: boolean;
};

function renderTokenStat(stat: TokenStat): TemplateResult {
  // prettier-ignore
  return html`${waIcon(stat.icon, { id: stat.id })}${formatCompactTokenCount(stat.value)}<wa-tooltip for=${stat.id}>${stat.tooltip}</wa-tooltip>`;
}

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
        subscription: true,
      };
    case 'kimi-code-subscription':
      return {
        label: 'Kimi Code',
        title: 'No charge; covered by your Kimi Code subscription',
        subscription: true,
      };
    case 'relay':
      return {
        label: 'relay',
        title: 'Routed through the TeXRA relay',
        subscription: false,
      };
    case 'api-key':
      return {
        label: 'your key',
        title: 'Billed through your configured API key',
        subscription: false,
      };
    default:
      return undefined;
  }
}

function usageCostLabel(cost: number, route: UsageRoute | undefined): string {
  const badge = usageRouteBadge(route);
  if (!badge) return formatCostUsd(cost);
  if (badge.subscription && cost === 0) {
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
        --gauge-height: 6px;
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
      }

      .context-gauge__track {
        position: relative;
        width: 80px;
        /* Pins the tick mark's height to the bar regardless of
           wa-progress-bar's internal box model. */
        height: var(--gauge-height);
      }

      .context-gauge__bar {
        width: 100%;
        --track-height: var(--gauge-height);
        --track-color: var(--wa-color-surface-border);
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

    const stats: TokenStat[] = [
      {
        icon: 'arrow-up',
        id: 'usage-input-icon',
        value: inputTokens,
        tooltip: 'Input tokens',
      },
      {
        icon: 'cloud-arrow-down',
        id: 'usage-cache-read-icon',
        value: cacheRead,
        tooltip: 'Cache read tokens (discounted)',
        onlyWhenPositive: true,
      },
      {
        icon: 'cloud-arrow-up',
        id: 'usage-cache-miss-icon',
        value: cacheMiss,
        tooltip: 'Cache miss tokens (full price)',
        onlyWhenPositive: true,
      },
      {
        icon: 'database',
        id: 'usage-cache-write-icon',
        value: cacheWrite,
        tooltip: 'Cache creation tokens (1.25x cost)',
        onlyWhenPositive: true,
      },
      {
        icon: 'arrow-down',
        id: 'usage-output-icon',
        value: outputTokens,
        tooltip: 'Output tokens',
      },
    ];

    const visible = stats.filter(
      (stat) => !stat.onlyWhenPositive || stat.value > 0,
    );

    return html`
      ${waIcon('chart-pie')}
      <span class="run-summary__label">Total usage:</span>
      <span class="run-summary__value">
        ${join(visible.map(renderTokenStat), ' · ')} ·
        ${this.renderCostRoute(cost)}
      </span>
    `;
  }

  private renderCostRoute(cost: number): TemplateResult {
    const route = this.usage?.usageRoute;
    const badge = usageRouteBadge(route);
    if (!badge) return html`${formatCostUsd(cost)}`;

    if (badge.subscription && cost === 0) {
      return html`<span
          id="usage-route-badge"
          class="run-summary__route run-summary__route--free"
          >Free · ${badge.label}</span
        ><wa-tooltip for="usage-route-badge">${badge.title}</wa-tooltip>`;
    }

    return html`${formatCostUsd(cost)} ·
      <span id="usage-route-badge" class="run-summary__route">
        ${badge.label}
      </span>
      <wa-tooltip for="usage-route-badge">${badge.title}</wa-tooltip>`;
  }

  private renderContext(): TemplateResult | typeof nothing {
    if (!this.contextState) return nothing;
    const { inputTokens, contextWindow, utilizationPercent } =
      this.contextState;
    const clamped = clamp(utilizationPercent, 0, 100);

    return html`
      <span id="usage-context-gauge" class="context-gauge">
        ${waIcon('window-maximize')}
        <span class="context-gauge__track">
          <wa-progress-bar
            class="context-gauge__bar"
            value=${clamped}
            label="${clamped.toFixed(0)}% context used"
            style=${styleMap({ '--indicator-color': fillColor(clamped) })}
          ></wa-progress-bar>
          <span
            id="usage-compaction-tick"
            class="context-gauge__tick"
            style=${styleMap({ left: `${COMPACTION_THRESHOLD}%` })}
          ></span>
          <wa-tooltip for="usage-compaction-tick"
            >Compaction at ${COMPACTION_THRESHOLD}%</wa-tooltip
          >
        </span>
        <span class="context-state__value">
          ${formatCompactTokenCount(inputTokens)} /
          ${formatCompactTokenCount(contextWindow)}
        </span>
      </span>
      <wa-tooltip for="usage-context-gauge"
        >${clamped.toFixed(0)}% context used</wa-tooltip
      >
    `;
  }

  private buildUsageLabel(): string {
    if (!this.usage) return '';
    const { inputTokens, outputTokens, cost } = this.usage;
    const costLabel = usageCostLabel(cost, this.usage.usageRoute);
    return `Total usage: ${formatCompactTokenCount(inputTokens)} input tokens, ${formatCompactTokenCount(outputTokens)} output tokens, ${costLabel}`;
  }
}
