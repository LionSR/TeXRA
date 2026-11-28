/**
 * `<plan-usage-meters>`: the status bar's subscription meters. One chip per
 * plan a listed model bills, showing its most-used window; the chip opens a
 * panel with every plan's windows, when each resets, when the figures were
 * learned, and a refresh. It shows what the host snapshot carries
 * (`HostSnapshot.planUsage`) and asks the host to read again; it keeps no
 * figures of its own.
 */

// Third-party imports
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/popover/popover.js';

// Local imports
import type { PlanUsage } from '@texra/shared/session/hostSnapshot';
import { modelAvailabilityLabel } from '@ui/copy/modelAccess';
import {
  formatSubscriptionUsageReset,
  formatSubscriptionUsageUpdated,
  subscriptionQuotaTone,
  subscriptionQuotaUsed,
  subscriptionUsageUnavailable,
  subscriptionUsageWindowLabel,
} from '@ui/copy/subscriptionUsage';
import { TexraElement } from '@ui/litBase';
import { TickerController } from '@ui/litControllers/TickerController';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { popoverPanelStyles } from '@ui/styles/overlaySurfaceStyles';
import { toneStyles } from '@ui/styles/toneStyles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { quotaBarStyles, renderQuotaBar } from '@ui/wa/quotaBar';

/** The plan as its provider names its tier, else as TeXRA names the plan. */
const planName = (usage: PlanUsage): string =>
  usage.planName ??
  modelAvailabilityLabel({
    availability: 'subscription-access',
    usageRoute: usage.plan,
  });

/** A plan's windows still running at `now`: a figure learned before its
 *  window reset says nothing about the window that followed. */
const current = (usage: PlanUsage, now: number): PlanUsage => ({
  ...usage,
  windows: usage.windows.filter(
    (window) => window.resetAt === undefined || window.resetAt > now,
  ),
});

/** The window a chip stands for: the one nearest its limit, whichever
 *  windows the plan has. */
const fullest = (usage: PlanUsage) =>
  usage.windows.toSorted((a, b) => b.percentUsed - a.percentUsed).at(0);

/** Why a plan shows no windows, in a line. */
function unknownLine(unknown: NonNullable<PlanUsage['unknown']>): string {
  return unknown === 'unobserved'
    ? 'Usage shows after the next reply on this plan.'
    : subscriptionUsageUnavailable(unknown);
}

@customElement('plan-usage-meters')
export class PlanUsageMeters extends TexraElement {
  static override styles = [
    TexraElement.styles,
    toneStyles,
    popoverPanelStyles,
    quotaBarStyles,
    css`
      :host {
        --popover-panel-width: 24rem;
        display: inline-flex;
        min-width: 0;
      }
      .chips {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        height: 100%;
        padding: 0 var(--wa-space-xs);
        border: 0;
        border-radius: var(--field-radius);
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .chips:hover {
        background: var(--surface-hover);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        white-space: nowrap;
      }
      .chip + .chip {
        margin-inline-start: var(--wa-space-xs);
      }
      .chip-percent {
        color: var(--tone-color, var(--wa-color-text-normal));
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-weight-medium);
      }
      .chip wa-progress-bar {
        width: 2.5rem;
      }
      .title {
        font-weight: var(--font-weight-medium);
        margin-inline-end: auto;
      }
      .plan {
        display: grid;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-xs) var(--wa-space-s);
      }
      .plan + .plan {
        border-block-start: var(--border-thin) solid var(--color-border);
      }
      .plan-head {
        display: flex;
        align-items: baseline;
        gap: var(--wa-space-xs);
      }
      .plan-name {
        font-weight: var(--font-weight-medium);
        margin-inline-end: auto;
      }
      .quiet {
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
      }
      .window {
        display: grid;
        grid-template-columns: 4.5rem minmax(0, 1fr) auto;
        align-items: center;
        column-gap: var(--wa-space-xs);
        font-variant-numeric: tabular-nums;
      }
      .window-reset {
        grid-column: 2 / -1;
      }
      .window-used {
        color: var(--tone-color, inherit);
      }
    `,
  ];

  /** What the host knows of each plan's quota. */
  @property({ attribute: false }) usage: readonly PlanUsage[] = [];

  /** The clock the reset and freshness words read, once a minute. */
  private readonly ticker = new TickerController(this, 60_000);

  private refresh(force: boolean): void {
    this.dispatchEvent(SessionUiEvents.host({ kind: 'refreshUsage', force }));
  }

  private renderChip(usage: PlanUsage): TemplateResult {
    const window = fullest(usage);
    if (window === undefined)
      return html`<span class="chip">${planName(usage)}</span>`;
    const tone = subscriptionQuotaTone(window);
    const toneClass = tone === undefined ? '' : `tone-${tone}`;
    return html`<span class="chip ${toneClass}">
      ${planName(usage)} ${renderQuotaBar(window.percentUsed, tone)}
      <span class="chip-percent">${Math.round(window.percentUsed)}%</span>
    </span>`;
  }

  private renderPlan(usage: PlanUsage, now: number): TemplateResult {
    return html`<section class="plan">
      <div class="plan-head">
        <span class="plan-name">${planName(usage)}</span>
        ${
          usage.at === undefined
            ? nothing
            : html`<span class="quiet"
                >${formatSubscriptionUsageUpdated(usage.at, now)}</span
              >`
        }
      </div>
      ${
        usage.unknown === undefined
          ? nothing
          : html`<span class="quiet">${unknownLine(usage.unknown)}</span>`
      }
      ${usage.windows.map((window) => {
        const tone = subscriptionQuotaTone(window);
        const toneClass = tone === undefined ? '' : `tone-${tone}`;
        const reset = formatSubscriptionUsageReset(window.resetAt, now);
        return html`<div class="window ${toneClass}">
          <span>${subscriptionUsageWindowLabel(window)}</span>
          ${renderQuotaBar(window.percentUsed, tone, subscriptionUsageWindowLabel(window))}
          <span class="window-used">${subscriptionQuotaUsed(window)}</span>
          ${reset ? html`<span class="window-reset quiet">${reset}</span>` : nothing}
        </div>`;
      })}
    </section>`;
  }

  override render(): TemplateResult | typeof nothing {
    // A plan with no credential has no usage to show and nothing to fix here.
    const now = this.ticker.now;
    const usage = this.usage
      .filter((plan) => plan.unknown !== 'missing_credentials')
      .map((plan) => current(plan, now));
    if (usage.length === 0) return nothing;
    return html`
      <button
        id="plan-usage"
        type="button"
        class="chips focus-ring-inset"
        aria-label="Subscription usage"
      >
        ${usage.map((plan) => this.renderChip(plan))}
      </button>
      <wa-popover
        for="plan-usage"
        placement="top-end"
        distance="6"
        without-arrow
        @wa-show=${() => this.refresh(false)}
      >
        <div class="popover-panel">
          <div class="popover-panel-head">
            <span class="title">Subscription usage</span>
            ${renderIconActionButton({
              id: 'plan-usage-refresh',
              icon: 'arrows-rotate',
              label: 'Check usage again',
              tooltip: 'Check usage again',
              onClick: () => this.refresh(true),
            })}
          </div>
          ${usage.map((plan) => this.renderPlan(plan, now))}
        </div>
      </wa-popover>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plan-usage-meters': PlanUsageMeters;
  }
}
