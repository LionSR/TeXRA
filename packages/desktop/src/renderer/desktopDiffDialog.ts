// Renderer-side <wa-dialog> host for the in-app diff view.
//
// The main process posts `desktop:showDiff` (see desktopDiffMessages.ts) with
// the original/proposed file contents already read from disk (the renderer is
// sandboxed and cannot read files itself). This module owns the dialog DOM
// and slots a <texra-diff-view> child into it. We render at most one dialog
// instance — repeated open() calls update the existing diff view's props.

import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, render, type TemplateResult } from 'lit';

import type { DesktopDiffPayload } from '../desktopDiffMessages.js';
import type { TexraDiffView } from '@progressView/frontend/components/TexraDiffView';

export interface DesktopDiffDialogController {
  element: HTMLElement;
  open(payload: DesktopDiffPayload): void;
  close(): void;
  isVisible(): boolean;
}

export function createDesktopDiffDialog(
  document: Document,
): DesktopDiffDialogController {
  const dialog = document.createElement('wa-dialog');
  dialog.classList.add('desktop-diff-dialog');
  dialog.setAttribute('label', 'Diff');

  let payload: DesktopDiffPayload | undefined;

  const renderTemplate = (): TemplateResult => {
    if (!payload) return html``;
    return html`
      <header class="desktop-diff-dialog-header">
        <h1>${payload.title}</h1>
        <p class="desktop-diff-dialog-paths">
          <span>${payload.originalPath}</span>
          <span aria-hidden="true">↔</span>
          <span>${payload.proposedPath}</span>
        </p>
      </header>
      <texra-diff-view
        class="desktop-diff-dialog-view"
        .originalText=${payload.originalText}
        .proposedText=${payload.proposedText}
        language=${payload.language ?? 'plaintext'}
      ></texra-diff-view>
      <div slot="footer" class="desktop-diff-dialog-actions">
        <wa-button
          appearance="filled"
          variant="brand"
          @click=${() => {
            dialog.open = false;
          }}
        >
          Close
        </wa-button>
      </div>
    `;
  };

  const rerender = () => render(renderTemplate(), dialog);

  // Dialog must always be in the DOM for `dialog.open = true` to mount it.
  // Keep the body container empty until the first open() so we don't pay
  // monaco-editor cost for users who never trigger a diff.
  rerender();

  return {
    element: dialog,
    open: (next) => {
      payload = next;
      rerender();
      // After Lit renders, the <texra-diff-view> is in the DOM. Setting
      // `dialog.open = true` shows the modal; wa-dialog handles backdrop,
      // focus trap, escape key, and focus restore.
      dialog.open = true;
      // Re-sync the diff-view props if it's already mounted (rerender above
      // updated the template, but a subsequent open() with the same payload
      // shape needs no extra work — Lit reuses the element).
      const view =
        dialog.querySelector<TexraDiffView>('texra-diff-view') ?? undefined;
      if (view) {
        view.originalText = next.originalText;
        view.proposedText = next.proposedText;
        view.language = next.language ?? 'plaintext';
      }
    },
    close: () => {
      dialog.open = false;
    },
    isVisible: () => dialog.open,
  };
}
