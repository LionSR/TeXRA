// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

/**
 * Visual-only mock of a header-level YOLO mode toggle. No real wiring —
 * clicking only flips a local @state so screenshots can show both states.
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

      .yolo-toggle {
        flex-shrink: 0;
      }

      .yolo-toggle::part(base) {
        min-height: var(--height-control, 24px);
        gap: var(--wa-space-3xs);
        font-size: var(--font-size-small);
        padding: 0 var(--wa-space-2xs);
        border-radius: var(--wa-border-radius-m);
      }

      .yolo-toggle--on::part(base) {
        background: var(--wa-color-warning-fill-loud);
        color: var(--wa-color-warning-on-loud);
      }

      .yolo-toggle--on::part(base):hover {
        background: var(--wa-color-warning-fill-loud);
        filter: brightness(1.05);
      }

      .yolo-toggle__indicator {
        font-size: var(--font-size-icon-sm);
      }
    `,
  ];

  @state() private active = false;

  override render(): TemplateResult {
    const label = this.active ? 'YOLO on' : 'YOLO off';
    const title = this.active
      ? 'YOLO mode is on — tool-use agents run hands-free'
      : 'YOLO mode is off — agents pause on each tool call';
    return html`
      <wa-button
        class=${classMap({
          'yolo-toggle': true,
          'yolo-toggle--on': this.active,
        })}
        appearance=${this.active ? 'accent' : 'plain'}
        size="small"
        aria-pressed=${this.active}
        title=${title}
        @click=${this.toggle}
      >
        <wa-icon
          slot="start"
          library=${TEXRA_ICON_LIBRARY}
          name=${this.active ? 'bolt' : 'shield'}
          class="yolo-toggle__indicator"
          variant="solid"
        ></wa-icon>
        ${label}
      </wa-button>
    `;
  }

  private toggle = (): void => {
    this.active = !this.active;
  };
}
