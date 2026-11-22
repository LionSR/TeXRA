// The editor pane's notice: a failed editor load, open, reload, or save is
// reported above the editor, not only to the log. A save that fails silently
// leaves the user believing the file is on disk, and a reload that fails
// silently leaves them editing a version that is no longer on disk: both can
// cost them work.

import { getBasename, extractErrorMessage } from '@texra-ai/harness/schemas';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import { html, nothing, render, type TemplateResult } from 'lit';

import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';

interface Notice {
  /** The file it is about; none for the editor itself failing to load. */
  readonly path: string | undefined;
  readonly message: string;
  /** The answers it offers, each a button. */
  readonly actions: readonly { readonly label: string; run(): void }[];
}

/** The danger callout a pane shows above its content for a failure, with
 *  the buttons that answer it. */
export function renderNoticeCallout(
  message: string,
  buttons: unknown = nothing,
): TemplateResult {
  return html`<wa-callout variant="danger" size="s" role="alert">
    ${waIcon('circle-exclamation', { slot: 'icon' })}
    <span class="desktop-editor-notice-text">${message}</span>
    ${buttons}
  </wa-callout>`;
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
        : renderNoticeCallout(notice.message, [
            ...notice.actions.map((action) =>
              renderLabeledActionButton({
                text: action.label,
                kind: 'secondary',
                onClick: () => action.run(),
              }),
            ),
            renderLabeledActionButton({
              text: 'Dismiss',
              onClick: () => show(undefined),
            }),
          ]),
      element,
    );
  }

  return {
    element,

    report(
      path: string | undefined,
      action: 'load' | 'open' | 'reload' | 'save',
      error: unknown,
    ): void {
      options.onError(error);
      const name = path === undefined ? '' : getBasename(path);
      const detail = extractErrorMessage(error);
      const headline = {
        load: "The editor couldn't load. Open a file to try again.",
        open: `Couldn't open ${name}.`,
        reload: `Couldn't reload ${name} from disk. The editor shows the last version read, and saving it would overwrite the file on disk.`,
        save: `Couldn't save ${name}. Your changes are still in the editor.`,
      }[action];
      show({
        path,
        message: detail ? `${headline} ${detail}` : headline,
        actions:
          action === 'save' && path !== undefined
            ? [{ label: 'Try again', run: () => options.retrySave(path) }]
            : [],
      });
    },

    /** A save found the file rewritten since the editor read it (a run, or
     *  another editor): nothing was written, and the user picks a side. */
    changedOnDisk(
      path: string,
      answers: { overwrite(): void; reload(): void },
    ): void {
      show({
        path,
        message: `${getBasename(path)} changed on disk since it was opened. Your changes are still in the editor.`,
        actions: [
          { label: 'Overwrite', run: answers.overwrite },
          { label: 'Reload from disk', run: answers.reload },
        ],
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
