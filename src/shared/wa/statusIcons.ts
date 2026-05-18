// Third-party imports
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { css, html, type CSSResult, type TemplateResult } from 'lit';

export type WaTagVariant =
  | 'brand'
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger';

export interface SetStatusFallback {
  readonly label: string;
  readonly variant?: WaTagVariant;
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
    return html`<wa-icon
      library="texra"
      name="check"
      class="status-check-icon"
      title=${title ?? 'Set'}
    ></wa-icon>`;
  }
  return html`<wa-tag variant=${fallback.variant ?? 'neutral'} size="small"
    >${fallback.label}</wa-tag
  >`;
}

export const statusCheckIconStyles: CSSResult = css`
  .status-check-icon {
    color: var(--wa-color-success-fill-loud);
    font-size: 1em;
  }
`;
