// Tab strip for the desktop shell.
//
// A hand-rolled Lit template rather than `<wa-tab-group>`: the strip needs
// per-tab close buttons, a dirty indicator, middle-click-to-close, and
// horizontal overflow scrolling. Driving all of that through wa-tab-group's
// slot contract fought the component more than it reused it. The individual
// controls still come from the shared `wa-*` primitives, so the styling stays
// consistent with the rest of the app.

import { html, nothing, type TemplateResult } from 'lit';

import { waIcon } from '@shared/wa/webAwesomeIcons';

import {
  isClosableTabKind,
  type DesktopTab,
  type DesktopTabState,
} from '../desktopWorkspaceTabs.js';

export interface TabStripCallbacks {
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  /** Invoked by the trailing "+" button; opens the new-tab menu. */
  onNew(anchor: HTMLElement): void;
}

function tabTemplate(
  tab: DesktopTab,
  isActive: boolean,
  callbacks: TabStripCallbacks,
): TemplateResult {
  const closable = isClosableTabKind(tab.kind);
  return html`
    <div
      class="desktop-tab"
      role="tab"
      tabindex=${isActive ? 0 : -1}
      aria-selected=${isActive ? 'true' : 'false'}
      data-tab-kind=${tab.kind}
      data-active=${isActive ? 'true' : 'false'}
      title=${tab.target ?? tab.title}
      @click=${() => callbacks.onActivate(tab.id)}
      @auxclick=${(event: MouseEvent) => {
        // Middle-click closes, matching every browser and editor. Guard on
        // button 1 so a right-click never destroys a tab.
        if (event.button === 1 && closable) {
          event.preventDefault();
          callbacks.onClose(tab.id);
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          callbacks.onActivate(tab.id);
        }
      }}
    >
      ${waIcon(tab.icon, { className: 'desktop-tab-icon' })}
      <span class="desktop-tab-label">${tab.title}</span>
      ${tab.dirty ? html`<span class="desktop-tab-dirty" aria-label="Unsaved changes"></span>` : nothing}
      ${
        closable
          ? html`
              <button
                type="button"
                class="desktop-tab-close"
                aria-label=${`Close ${tab.title}`}
                @click=${(event: MouseEvent) => {
                  // Without this the click also hits the tab body and
                  // activates the tab being closed.
                  event.stopPropagation();
                  callbacks.onClose(tab.id);
                }}
              >
                ${waIcon('xmark')}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

export function tabStripTemplate(
  state: DesktopTabState,
  callbacks: TabStripCallbacks,
): TemplateResult {
  return html`
    <div class="desktop-tab-strip" role="tablist" aria-label="Open tabs">
      <div class="desktop-tab-strip-scroll">
        ${state.tabs.map((tab) =>
          tabTemplate(tab, tab.id === state.activeTabId, callbacks),
        )}
      </div>
      <button
        type="button"
        class="desktop-tab-new"
        aria-label="New tab"
        title="New tab"
        @click=${(event: MouseEvent) =>
          callbacks.onNew(event.currentTarget as HTMLElement)}
      >
        ${waIcon('plus')}
      </button>
    </div>
  `;
}
