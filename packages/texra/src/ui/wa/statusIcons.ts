// Third-party imports
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { css, html, type CSSResult, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports
import { credentialOriginLabel } from '@ui/copy/credentials';
import type { ProviderKeyStatus } from '@texra/shared/settingsView/profileViewMessages';
import type { IconName } from '@ui/wa/iconNames';
import { waIcon } from '@ui/wa/webAwesomeIcons';

/**
 * The icon buckets a script call's status sorts into (`ScriptStage`); a run's
 * and a stage's glyph come from `runStatus`'s tone table.
 */
type TerminalStatusKind = 'cancelled' | 'completed' | 'failed' | 'running';

const TERMINAL_STATUS_ICON: Readonly<Record<TerminalStatusKind, IconName>> = {
  failed: 'circle-exclamation',
  completed: 'check',
  cancelled: 'circle-stop',
  running: 'circle',
};

/** The steady wa-icon name for a terminal-run status bucket. */
export function terminalStatusIcon(kind: TerminalStatusKind): IconName {
  return TERMINAL_STATUS_ICON[kind];
}

type WaTagVariant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

interface SetStatusFallback {
  readonly label: string;
  readonly variant?: WaTagVariant;
}

/** `wa-tag` reads compact and inline; `wa-badge` reads as a filled pill. */
type StatusBadgeAppearance = 'badge' | 'tag';

interface StatusBadgeOptions {
  /** Pre-rendered leading icon (a `waIcon()` call, a spinner, ...). */
  readonly icon: TemplateResult;
  readonly label: string;
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
  appearance = 'tag',
  className,
}: StatusBadgeOptions): TemplateResult {
  if (appearance === 'badge') {
    // prettier-ignore
    return html`<wa-badge variant="neutral" appearance="filled" class=${ifDefined(className)}>${icon} ${label}</wa-badge>`;
  }
  // prettier-ignore
  return html`<wa-tag variant="neutral" size="s" class=${ifDefined(className)}>${icon} ${label}</wa-tag>`;
}

interface SetStatusIconOptions<Status extends string, Success extends Status> {
  readonly status: Status;
  /** The status the green check stands for. */
  readonly success: Success;
  /** A labeled tag for every other status: total, so a new status is a
   *  compile error here instead of a check. */
  readonly fallbacks: Readonly<
    Record<Exclude<Status, Success>, SetStatusFallback>
  >;
  /** Tooltip text for the green check rendered for `success`. */
  readonly title?: string;
}

/**
 * Render a green-check wa-icon for the `success` status, or a labeled wa-tag
 * using the status's fallback otherwise.
 */
export function renderSetStatusIcon<
  Status extends string,
  Success extends Status,
>({
  status,
  success,
  fallbacks,
  title,
}: SetStatusIconOptions<Status, Success>): TemplateResult {
  if (status === success) {
    // `label` exposes the check's meaning to assistive technology; `title`
    // alone is a hover-only tooltip on an otherwise aria-hidden icon.
    const label = title ?? 'Set';
    return waIcon('check', {
      className: 'status-check-icon',
      label,
      title: label,
    });
  }
  // cast: a status other than `success` is a key of the total table.
  const fallback = fallbacks[status as Exclude<Status, Success>];
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
    success: 'secret',
    title: credentialOriginLabel('secret', 'key'),
    fallbacks: {
      env: { label: credentialOriginLabel('env', 'key') },
      none: { label: credentialOriginLabel('none', 'key') },
    },
  });
}
