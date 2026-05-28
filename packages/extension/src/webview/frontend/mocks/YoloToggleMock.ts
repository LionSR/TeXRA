// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { renderIconActionButton } from '@shared/wa/actionButtons';

/**
 * Visual-only mock of a header-level YOLO mode toggle. Mirrors the real
 * `yolo-toggle-button` styling from StreamHeader (icon-only, `is-active`
 * applies a tinted background via color-mix) so the gallery reflects the
 * production toggle, not an invented one. No live wiring — clicking only
 * flips a local @state.
 */
@customElement('texra-yolo-toggle-mock')
export class YoloToggleMock extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
      }

      /* Mirror StreamHeader.ts: .yolo-toggle-button + .is-active tint. */
      .yolo-toggle-button {
        flex-shrink: 0;
      }

      .yolo-toggle-button.is-active {
        --_toggle-color: var(--color-error);
        border-radius: var(--border-radius);
        color: var(--_toggle-color);
        background-color: color-mix(
          in srgb,
          var(--_toggle-color) 15%,
          transparent
        );
      }
    `,
  ];

  @state() private active = false;

  override render(): TemplateResult {
    const title = this.active
      ? 'Edit auto-accept active — click to resume approval prompts'
      : 'Skip edit approvals (auto-accept file changes)';
    return html`
      <span
        class=${classMap({
          'yolo-toggle-button': true,
          'is-active': this.active,
        })}
        @click=${this.toggle}
      >
        ${renderIconActionButton({
          icon: 'shield',
          label: title,
          title,
        })}
      </span>
    `;
  }

  private toggle = (): void => {
    this.active = !this.active;
  };
}
