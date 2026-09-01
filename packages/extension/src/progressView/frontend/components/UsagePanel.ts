// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { join } from 'lit/directives/join.js';
import { styleMap } from 'lit/directives/style-map.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared schemas, styles, and constants
import {
  isEmptyUsage,
  type ContextStateData,
  type TokenUsageStats,
  type UsageRoute,
} from '@shared/schemas';
import { designTokens } from '@shared/styles';
import { usageCostLabel, usageRouteBadge } from '@shared/copy/modelAccess';
import { focusRingStyles } from '@shared/styles/controlStyles';

// Local imports - shared icons and utils
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { clamp, formatCompactTokenCount } from '@utils/core';
import { formatCostUsd } from '@utils/text/stringUtils';

// Local imports - progress view
import { ELEMENT_IDS } from '../constants';

/** One token counter in the usage strip: icon, count, and its tooltip. */
type TokenStat = {
  icon: TeXRAIconName;
  id: string;
  value: number;
  tooltip: string;
  /** Optional counters stay hidden until the run reports them. */
  onlyWhenPositive?: boolean;
};

function renderTokenStat(stat: TokenStat): TemplateResult {
  const tooltip = `${stat.tooltip}: ${stat.value.toLocaleString('en-US')}`;
  // prettier-ignore
  return html`<span id=${stat.id} class="token-stat">${waIcon(stat.icon)}${formatCompactTokenCount(stat.value)}</span><wa-tooltip for=${stat.id}>${tooltip}</wa-tooltip>`;
}

/** Solid fill color based on context utilization. */
function fillColor(percent: number): string {
  if (percent <= 65) return 'var(--color-success)';
  if (percent <= 80) return 'var(--color-warning)';
  return 'var(--color-status-error)';
}

/**
 * Free-tier decision for the visible footer badge: `null` when the route has
 * no badge (plain cost), otherwise `free` (subscription route with zero
 * cost) plus the badge's compact label. Only
 * {@link UsagePanel.renderCostRoute} consumes this; the aria summary's shared
 * {@link usageCostLabel} re-derives the same `subscription && cost === 0`
 * predicate from `usageRouteBadge`, so changing a subscription route touches
 * both.
 */
function usageRouteDecision(
  cost: number,
  route: UsageRoute | undefined,
): { free: boolean; compactLabel: string } | null {
  const badge = usageRouteBadge(route);
  if (!badge) return null;
  return {
    free: badge.subscription && cost === 0,
    compactLabel: badge.compactLabel,
  };
}

@customElement('usage-panel')
export class UsagePanel extends LitElement {
  static override styles = [
    designTokens,
    focusRingStyles,
    css`
      :host {
        display: block;
      }

      .usage-summary-footer {
        border-top: var(--border-thin) solid var(--color-border);
        background-color: var(--wa-color-surface-lowered);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        display: flex;
        flex-wrap: wrap;
        row-gap: var(--wa-space-3xs);
        justify-content: space-between;
        align-items: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      /* No opacity here or on the icons below. --color-text-secondary is
         already color-mix(… 70%, transparent), so the extra 0.85 (and a
         further 0.7 on icons) compounded to 0.595 / 0.4165 effective alpha:
         text measured 4.32:1 (Dark+) and 3.34:1 (Light Modern) against AA's
         4.5:1, and the icons missed the 3:1 non-text minimum in all four
         default themes. The token carries the de-emphasis on its own. */
      :is(.run-summary, .context-state) {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      :is(.run-summary, .context-state) wa-icon {
        font-size: var(--font-size-icon-sm);
      }

      /* Each compact counter needs a keyboard-reachable explanation. Keeping
         the icon and value together also prevents either half wrapping away
         from the other at narrow widths. */
      .token-stat {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        border-radius: var(--border-radius-small);
        white-space: nowrap;
      }

      .run-summary__route {
        font-weight: var(--wa-font-weight-semibold);
        white-space: nowrap;
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
        border-radius: var(--border-radius-small);
      }

      .context-gauge__track {
        width: 80px;
        height: var(--gauge-height);
      }

      .context-gauge__bar {
        width: 100%;
        --track-height: var(--gauge-height);
        --track-color: var(--wa-color-surface-border);
      }

      .run-summary {
        min-width: 0;
        margin-inline-start: auto;
      }

      /* Token counts and cost tick on every stream event inside a
         right-aligned strip, so proportional digits shifted the whole footer
         on each update. Same treatment ToolTimer and WorktreeChip already use. */
      :is(.run-summary__value, .context-state__value) {
        color: var(--wa-color-text-normal);
        font-variant-numeric: tabular-nums;
      }

      .run-summary__value {
        min-width: 0;
      }
    `,
  ];

  @property({ attribute: false }) usage: TokenUsageStats | null = null;
  @property({ attribute: false }) contextState: ContextStateData | null = null;

  /** Whether the usage stats have any non-zero values worth displaying. */
  private get hasUsage(): boolean {
    return this.usage != null && !isEmptyUsage(this.usage);
  }

  /** `ContextStateDataSchema` requires both gauge fields, so presence is all
   *  there is to test. `renderContext` owns visibility from here. */
  private get hasContext(): boolean {
    return this.contextState != null;
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.hasUsage && !this.hasContext) {
      return nothing;
    }

    return html`
      <div class="usage-summary-footer">
        <span id=${ELEMENT_IDS.CONTEXT_STATE} class="context-state">
          ${this.renderContext()}
        </span>
        <span
          id=${ELEMENT_IDS.RUN_SUMMARY}
          class="run-summary focus-ring-inset"
          role=${this.usage ? 'group' : nothing}
          aria-label=${this.buildUsageLabel()}
          tabindex=${this.usage ? '0' : nothing}
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
    const reasoning = this.usage.reasoningTokens ?? 0;

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
        tooltip: 'Cache creation tokens (1.25× cost)',
        onlyWhenPositive: true,
      },
      {
        icon: 'arrow-down',
        id: 'usage-output-icon',
        value: outputTokens,
        tooltip: 'Output tokens',
      },
      {
        icon: 'comments',
        id: 'usage-reasoning-icon',
        value: reasoning,
        tooltip: 'Reasoning tokens',
        onlyWhenPositive: true,
      },
    ];

    const visible = stats.filter(
      (stat) => !stat.onlyWhenPositive || stat.value > 0,
    );

    return html`
      ${waIcon('chart-pie')}
      <span class="run-summary__value">
        ${join(visible.map(renderTokenStat), ' · ')} ·
        ${this.renderCostRoute(cost)}
      </span>
    `;
  }

  private renderCostRoute(cost: number): TemplateResult {
    const decision = usageRouteDecision(cost, this.usage?.usageRoute);
    if (!decision) return html`${formatCostUsd(cost)}`;

    if (decision.free) {
      return html`<span
        id="usage-route-badge"
        class="run-summary__route run-summary__route--free"
        >Free · ${decision.compactLabel}</span
      >`;
    }

    return html`${formatCostUsd(cost)} ·
      <span id="usage-route-badge" class="run-summary__route">
        ${decision.compactLabel}
      </span>`;
  }

  private renderContext(): TemplateResult | typeof nothing {
    if (!this.contextState) return nothing;
    const { inputTokens, contextWindow, utilizationPercent } =
      this.contextState;
    // The bar is a widget that cannot overflow its own track, so it takes the
    // clamped value. The *text* states what the handler measured, floored at
    // 1% so a window that is genuinely in use never reads as `0% context
    // used` — the rule `formatSubscriptionUsagePercent` sets and the CLI
    // status bar already applies to this same number.
    const clamped = clamp(utilizationPercent, 0, 100);
    const roundedPercent =
      utilizationPercent > 0 ? Math.max(1, Math.round(utilizationPercent)) : 0;
    const percentLabel = `${roundedPercent}% context used`;

    return html`
      <span id="usage-context-gauge" class="context-gauge" tabindex="0">
        ${waIcon('window-maximize')}
        <span class="context-gauge__track">
          <wa-progress-bar
            class="context-gauge__bar"
            value=${clamped}
            label=${percentLabel}
            style=${styleMap({ '--indicator-color': fillColor(clamped) })}
          ></wa-progress-bar>
        </span>
        <span class="context-state__value">
          ${formatCompactTokenCount(inputTokens)} /
          ${formatCompactTokenCount(contextWindow)}
        </span>
      </span>
      <wa-tooltip for="usage-context-gauge"
        >${percentLabel} (${formatCompactTokenCount(inputTokens)} of
        ${formatCompactTokenCount(contextWindow)} tokens)</wa-tooltip
      >
    `;
  }

  private buildUsageLabel(): string {
    if (!this.usage) return '';
    const { inputTokens, outputTokens, cost } = this.usage;
    // The shared rule omits a zero-cost unknown route; the aria summary
    // still states it as "$0.000".
    const costLabel =
      usageCostLabel(cost, this.usage.usageRoute) ?? formatCostUsd(cost);
    const parts = [`${formatCompactTokenCount(inputTokens)} input tokens`];
    const optionalParts: ReadonlyArray<readonly [number, string]> = [
      [this.usage.cacheReadInputTokens ?? 0, 'cache read tokens'],
      [this.usage.cacheMissInputTokens ?? 0, 'cache miss tokens'],
      [this.usage.cacheCreationInputTokens ?? 0, 'cache creation tokens'],
    ];
    for (const [value, label] of optionalParts) {
      if (value > 0) parts.push(`${formatCompactTokenCount(value)} ${label}`);
    }
    parts.push(`${formatCompactTokenCount(outputTokens)} output tokens`);
    const reasoning = this.usage.reasoningTokens ?? 0;
    if (reasoning > 0) {
      parts.push(`${formatCompactTokenCount(reasoning)} reasoning tokens`);
    }
    parts.push(costLabel);
    return `Total usage: ${parts.join(', ')}`;
  }
}
