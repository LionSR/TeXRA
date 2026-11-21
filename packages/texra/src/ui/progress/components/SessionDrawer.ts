/**
 * The Sessions drawer: a `wa-drawer` from the start edge, headed by the
 * project name with close (Escape and a click outside close it too), then
 * search, the real `<run-tabs>` in group
 * sections as its body, and "Open tasks in editor" as its footer. New
 * task has one home, the shell header; the drawer carries no second one.
 *
 * `Surface.drawerOpen` opens it and `Surface.search` filters it; both reach
 * the root as `surface-action` events. The docked list of the wide editor
 * tab is the same body inside `<progress-app>`, never this element.
 */
import { css, html, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import type WaDrawer from '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { overlaySurfaceStyles } from '@ui/styles/overlaySurfaceStyles';
import { TexraElement } from '@ui/litBase';
import { truncateDeclarations } from '@ui/styles/commonViewStyles';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import type { SessionView } from '@texra-ai/harness/schemas';
import './RunTabs';
import { renderTaskFilter, taskFilterStyles } from './taskFilter';

@customElement('session-drawer')
export class SessionDrawer extends TexraElement {
  static override styles = [
    TexraElement.styles,
    overlaySurfaceStyles,
    taskFilterStyles,
    css`
      wa-drawer {
        --size: 320px;
      }

      .overlay-title {
        min-width: 0;
        ${truncateDeclarations}
      }

      .drawer-body {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: var(--wa-space-3xs);
      }

      .drawer-footer {
        flex: 0 0 auto;
        border-top: var(--border-thin) solid var(--wa-color-surface-border);
      }
    `,
  ];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;
  /** The desktop renders no drawer. */
  @property() placement: 'sidebar' | 'editor' = 'sidebar';

  @query('wa-drawer') private drawer!: WaDrawer;

  /** Opening after the first render lets the drawer animate in and note the
   *  focus it returns to on close. */
  override firstUpdated(): void {
    this.drawer.open = true;
  }

  /** Every way out (the button, Escape, a click outside) runs the drawer's
   *  close; the surface forgets it once that has finished. */
  private handleAfterHide = (event: Event): void => {
    if (event.target !== event.currentTarget) return;
    this.dispatchEvent(
      SessionUiEvents.surface({ kind: 'drawer', open: false }),
    );
  };

  private openInEditor = (): void => {
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: this.placement === 'editor' ? 'popBack' : 'popOut',
      }),
    );
  };

  override render(): TemplateResult {
    const inEditor = this.placement === 'editor';
    return html`
      <wa-drawer
        label="Tasks"
        placement="start"
        without-header
        light-dismiss
        @wa-after-hide=${this.handleAfterHide}
      >
        <div class="overlay-header">
          <span class="overlay-title">${this.host?.project.name ?? ''}</span>
          ${renderIconActionButton({
            id: 'drawer-close',
            icon: 'xmark',
            label: 'Close',
            tooltip: 'Close',
            onClick: () => {
              this.drawer.open = false;
            },
          })}
        </div>
        ${renderTaskFilter(this, this.surface?.search ?? '')}
        <div class="drawer-body">
          <run-tabs
            sections
            .view=${this.view}
            .surface=${this.surface}
          ></run-tabs>
        </div>
        <div class="drawer-footer">
          ${renderLabeledActionButton({
            icon: inEditor ? 'backward-step' : 'picture-in-picture',
            text: inEditor ? 'Back to sidebar' : 'Open tasks in editor',
            kind: 'ghost',
            className: 'is-row',
            onClick: this.openInEditor,
          })}
        </div>
      </wa-drawer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-drawer': SessionDrawer;
  }
}
