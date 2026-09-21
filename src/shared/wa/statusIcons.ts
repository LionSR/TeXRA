// Third-party imports
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { css, html, type CSSResult, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports
import type {
  ProviderKeyStatus,
} from '@shared/settingsView/settingsViewMessages';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

/**
 * Abstract terminal-run outcome, independent of any one surface's status
 * union (`RunPhase`, `WorkflowCallProgress['status']`, ...). Callers
 * classify their own domain-specific status into one of these buckets; this
 * module is the single source of truth for which icon each bucket gets.
 */
export type TerminalStatusKind =
  'cancelled' | 'completed' | 'failed' | 'running';

const TERMINAL_STATUS_ICON: Readonly<
  Record<TerminalStatusKind, TeXRAIconName>
> = {
  failed: 'circle-exclamation',
  completed: 'check',
  cancelled: 'circle-stop',
  running: 'circle',
};

/** The steady wa-icon name for a terminal-run status bucket. */
export function terminalStatusIcon(kind: TerminalStatusKind): TeXRAIconName {
  return TERMINAL_STATUS_ICON[kind];
}

type WaTagVariant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

interface SetStatusFallback {
  readonly label: string;
  readonly variant?: WaTagVariant;
}

/** `wa-tag` reads compact and inline; `wa-badge` reads as a filled pill. */
type StatusBadgeAppearance = 'badge' | 'tag';

export interface StatusBadgeOptions {
  /** Pre-rendered leading icon (a `waIcon()` call, a spinner, ...). */
  readonly icon: TemplateResult;
  readonly label: string;
  readonly variant?: WaTagVariant;
  readonly appearance?: StatusBadgeAppearance;
  readonly className?: string;
}

/**
 * Single source of truth for the "icon + label" status indicator, rendered as
 * either a `wa-badge` (filled pill) or a `wa-tag` (compact inline chip) so the
 * settingsView and progressView surfaces cannot drift on markup independently.
 */
export function renderStatusBadge({
  icon,
  label,
  variant = 'neutral',
  appearance = 'tag',
  className,
}: StatusBadgeOptions): TemplateResult {
  if (appearance === 'badge') {
    // prettier-ignore
    return html`<wa-badge variant=${variant} appearance="filled" class=${ifDefined(className)}>${icon} ${label}</wa-badge>`;
  }
  // prettier-ignore
  return html`<wa-tag variant=${variant} size="s" class=${ifDefined(className)}>${icon} ${label}</wa-tag>`;
}

export interface SetStatusIconOptions<Status extends string> {
  readonly status: Status;
  readonly fallbacks: Partial<Record<Status, SetStatusFallback>>;
  /** Tooltip text for the green check rendered when `status` is not in `fallbacks`. */
  readonly title?: string;
}

/**
 * Render a green-check wa-icon when `status` has no entry in `fallbacks`, or a
 * labeled wa-tag using the matching fallback otherwise.
 */
export function renderSetStatusIcon<Status extends string>({
  status,
  fallbacks,
  title,
}: SetStatusIconOptions<Status>): TemplateResult {
  const fallback = fallbacks[status];
  if (!fallback) {
    // `label` exposes the check's meaning to assistive technology; `title`
    // alone is a hover-only tooltip on an otherwise aria-hidden icon.
    const label = title ?? 'Set';
    return waIcon('check', {
      className: 'status-check-icon',
      label,
      title: label,
    });
  }
  return html`<wa-tag variant=${fallback.variant ?? 'neutral'} size="s"
    >${fallback.label}</wa-tag
  >`;
}

export const statusCheckIconStyles: CSSResult = css`
  .status-check-icon {
    color: var(--wa-color-success-fill-loud);
    font-size: 1em;
  }
`;

/**
 * Provider API-key status icon. The API Configuration list owns key actions;
 * the model list mirrors the status read-only — one config so the two
 * surfaces cannot drift.
 */
export function renderKeyStatusIcon(
  status: ProviderKeyStatus['status'],
): TemplateResult {
  return renderSetStatusIcon({
    status,
    title: 'Key set',
    fallbacks: {
      env: { label: 'Env' },
      'not-set': { label: 'Not set' },
    },
  });
}
