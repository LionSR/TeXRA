// Third-party imports
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { css, html, type CSSResult, type TemplateResult } from 'lit';

type TagVariant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

export interface SetStatusIconOptions {
  /** Whether the underlying value is "set" (renders as a green check). */
  readonly isSet: boolean;
  /** Label shown in the fallback wa-tag when `isSet` is false. */
  readonly fallbackLabel: string;
  /** Variant applied to the fallback wa-tag. */
  readonly fallbackVariant?: TagVariant;
  /** Tooltip text for the green check when `isSet` is true. */
  readonly title?: string;
}

/**
 * Render a green-check wa-icon when the underlying value is set, or a labeled
 * wa-tag otherwise. Used by provider API keys, GitHub tokens, and similar
 * "is configured" indicators across the settings UI.
 */
export function renderSetStatusIcon({
  isSet,
  fallbackLabel,
  fallbackVariant = 'neutral',
  title,
}: SetStatusIconOptions): TemplateResult {
  if (isSet) {
    return html`<wa-icon
      library="texra"
      name="check"
      class="status-check-icon"
      title=${title ?? 'Set'}
    ></wa-icon>`;
  }
  return html`<wa-tag variant=${fallbackVariant} size="small"
    >${fallbackLabel}</wa-tag
  >`;
}

/**
 * Single source of truth for the green-check status icon styling. Consumed by
 * any view that renders `renderSetStatusIcon` or the `status-check-icon`
 * class directly.
 */
export const statusCheckIconStyles: CSSResult = css`
  .status-check-icon {
    color: var(--wa-color-success-fill-loud);
    font-size: 1em;
  }
`;
