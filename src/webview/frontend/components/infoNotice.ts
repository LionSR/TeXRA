/**
 * Shared renderer for dismissible informational notices in the main view.
 *
 * Keeps inline hints and full-width help banners on the same structure so
 * layout, dismiss controls, and ARIA roles stay consistent.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

export type InfoNoticeVariant = 'banner' | 'inline';

type InfoNoticeDismissConfig = {
  title: string;
  ariaLabel: string;
  label?: string;
  onDismiss: () => void;
};

type InfoNoticeOptions = {
  ariaLabel: string;
  content: TemplateResult;
  variant: InfoNoticeVariant;
  id?: string;
  leading?: TemplateResult | typeof nothing;
  actions?: TemplateResult | typeof nothing;
  secondary?: TemplateResult | typeof nothing;
  dismiss?: InfoNoticeDismissConfig;
};

function renderDismissControl(
  dismiss: InfoNoticeDismissConfig,
): TemplateResult {
  if (dismiss.label) {
    return html`
      <button
        class="info-notice__dismiss-button"
        title=${dismiss.title}
        aria-label=${dismiss.ariaLabel}
        @click=${dismiss.onDismiss}
      >
        ${dismiss.label}
      </button>
    `;
  }

  return html`
    <vscode-toolbar-button
      class="info-notice__dismiss-icon"
      icon="close"
      title=${dismiss.title}
      aria-label=${dismiss.ariaLabel}
      @click=${dismiss.onDismiss}
    ></vscode-toolbar-button>
  `;
}

export function renderInfoNotice({
  ariaLabel,
  content,
  variant,
  id,
  leading = nothing,
  actions = nothing,
  secondary = nothing,
  dismiss,
}: InfoNoticeOptions): TemplateResult {
  const trailing =
    actions !== nothing || dismiss
      ? html`
          <div class="info-notice__actions">
            ${actions} ${dismiss ? renderDismissControl(dismiss) : nothing}
          </div>
        `
      : nothing;

  return html`
    <div
      id=${id ?? nothing}
      class="info-notice info-notice--${variant}"
      role="note"
      aria-label=${ariaLabel}
    >
      <div class="info-notice__main">
        ${leading !== nothing
          ? html`<div class="info-notice__leading">${leading}</div>`
          : nothing}
        <div class="info-notice__content">${content}</div>
        ${trailing}
      </div>
      ${secondary !== nothing
        ? html`<div class="info-notice__secondary">${secondary}</div>`
        : nothing}
    </div>
  `;
}
