// Hero empty-state pattern shared between hosts. Consumers style via the
// .empty-state-* class hooks; the helper owns the structure.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import { waIcon, type TeXRAIconName } from './webAwesomeIcons';

export interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly appearance?: 'filled' | 'outlined';
  readonly variant?: 'brand' | 'neutral';
}

export interface EmptyStateOptions {
  readonly icon: TeXRAIconName;
  readonly title: string;
  readonly body?: string;
  readonly actions?: readonly EmptyStateAction[];
  readonly className?: string;
}

export function renderEmptyState({
  icon,
  title,
  body,
  actions,
  className,
}: EmptyStateOptions): TemplateResult {
  return html`
    <section class=${ifDefined(className)}>
      ${waIcon(icon, { className: 'empty-state-icon' })}
      <h2 class="empty-state-title">${title}</h2>
      ${body ? html`<p class="empty-state-body">${body}</p>` : nothing}
      ${actions && actions.length > 0
        ? html`
            <div class="empty-state-actions">
              ${actions.map(
                (action) => html`
                  <wa-button
                    appearance=${action.appearance ?? 'outlined'}
                    variant=${action.variant ?? 'neutral'}
                    @click=${action.onClick}
                  >
                    ${action.label}
                  </wa-button>
                `,
              )}
            </div>
          `
        : nothing}
    </section>
  `;
}
