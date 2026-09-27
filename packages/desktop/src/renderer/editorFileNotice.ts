// The editor pane's notice: a failed editor load, open, or save is reported
// above the editor, not only to the log. A save that fails silently leaves the
// user believing the file is on disk, which is the one failure here that can
// cost them work.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import { html, nothing, render } from 'lit';

import { waIcon } from '@ui/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';
import { extractErrorMessage } from '@utils/errors/errorMessage';

interface Notice {
  /** The file it is about; none for the editor itself failing to load. */
  readonly path: string | undefined;
  readonly message: string;
  retry?(): void;
}

export function createEditorFileNotice(options: {
  /** The log sink; every reported failure goes there as well. */
  onError(error: unknown): void;
  /** Saves `path` again, even if another file is showing by now. */
  retrySave(path: string): void;
}) {
  const element = document.createElement('div');
  element.className = 'desktop-editor-notice';
  let notice: Notice | undefined;

  function show(next: Notice | undefined): void {
    notice = next;
    render(
      notice === undefined
        ? nothing
        : html`<wa-callout variant="danger" size="s" role="alert">
            ${waIcon('triangle-exclamation', { slot: 'icon' })}
            <span class="desktop-editor-notice-text">${notice.message}</span>
            ${
              notice.retry
                ? html`<wa-button
                    size="s"
                    appearance="outlined"
                    @click=${notice.retry}
                    >Try again</wa-button
                  >`
                : nothing
            }
            <wa-button
              size="s"
              appearance="plain"
              @click=${() => show(undefined)}
              >Dismiss</wa-button
            >
          </wa-callout>`,
      element,
    );
  }

  return {
    element,

    report(
      path: string | undefined,
      action: 'load' | 'open' | 'save',
      error: unknown,
    ): void {
      options.onError(error);
      const name = path === undefined ? '' : getBasename(path);
      const detail = extractErrorMessage(error);
      const headline = {
        load: "The editor couldn't load. Open a file to try again.",
        open: `Couldn't open ${name}.`,
        save: `Couldn't save ${name}. Your changes are still in the editor.`,
      }[action];
      show({
        path,
        message: detail ? `${headline} ${detail}` : headline,
        ...(action === 'save' && path !== undefined
          ? { retry: () => options.retrySave(path) }
          : {}),
      });
    },

    /** A later success on the same file, or any file once the editor
     *  loads, retires the notice. */
    clear(path: string): void {
      if (notice !== undefined && (notice.path ?? path) === path) {
        show(undefined);
      }
    },
  };
}
