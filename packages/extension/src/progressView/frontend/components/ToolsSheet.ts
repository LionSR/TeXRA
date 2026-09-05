/**
 * The Tools sheet (PRD 12.1): a bottom sheet titled LaTeXDiffs hosting the
 * real `<latexdiffs-section>` on properties. Reachable from any state
 * through the header overflow; `Surface.toolsSheetOpen` opens and closes
 * it. The section's selections ride in `Surface.launch` (base, edited,
 * commit) and its option lists in the `host` snapshot; each verb leaves as
 * a `host-request` and each selection as a `surface-action`.
 */
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

import type {
  BaseFileChangeDetail,
  CommitChangeDetail,
  EditedFileChangeDetail,
  FileActionDetail,
  LatexDiffsActionDetail,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { matchesEditedFile } from '@shared/launcher/editedFileMatch';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import '@webview/frontend/components/LatexDiffsSection';

@customElement('tools-sheet')
export class ToolsSheet extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 3;
        display: block;
      }

      .scrim {
        position: absolute;
        inset: 0;
        background: color-mix(
          in srgb,
          var(--wa-color-surface-default) 55%,
          transparent
        );
      }

      .sheet {
        position: absolute;
        inset-inline: 0;
        bottom: 0;
        max-height: 62%;
        display: flex;
        flex-direction: column;
        background: var(--wa-color-surface-default);
        color: var(--wa-color-text-normal);
        border-top: var(--border-thin) solid var(--wa-color-surface-border);
        box-shadow: var(--wa-shadow-l);
      }

      .sheet-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        flex: 0 0 auto;
        min-height: var(--height-header, 38px);
        padding: 0 var(--wa-space-2xs) 0 var(--wa-space-xs);
        border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
      }

      .sheet-title {
        flex: 1 1 auto;
        font-weight: var(--font-weight-semibold);
      }

      latexdiffs-section {
        display: block;
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: var(--wa-space-3xs) var(--wa-space-2xs) var(--wa-space-xs);
      }
    `,
  ];

  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;

  private close = (): void => {
    this.dispatchEvent(
      SessionUiEvents.surface({ kind: 'toolsSheet', open: false }),
    );
  };

  private setLaunch(patch: Partial<Surface['launch']>): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'launch', patch }));
  }

  private emptyFile(type: FileActionDetail['type']): void {
    if (type === 'base') this.setLaunch({ baseFile: '' });
    else if (type === 'edited') this.setLaunch({ editedFile: '' });
  }

  override render(): TemplateResult | typeof nothing {
    const launch = this.surface?.launch;
    const host = this.host;
    if (!launch || !host) return nothing;
    // The edited candidates follow the base: the catalog is base-neutral,
    // and a selection of another base is not one for this base.
    const editedFileOptions = host.fileOptions.editedFile.filter((file) =>
      matchesEditedFile(file, launch.baseFile),
    );
    const editedFile = editedFileOptions.includes(launch.editedFile ?? '')
      ? (launch.editedFile ?? '')
      : '';
    return html`
      <div class="scrim" @click=${this.close}></div>
      <div class="sheet" role="dialog" aria-label="LaTeXDiffs">
        <div class="sheet-header">
          <span class="sheet-title">LaTeXDiffs</span>
          ${renderIconActionButton({
            id: 'tools-sheet-close',
            icon: 'xmark',
            label: 'Close',
            tooltip: 'Close',
            onClick: this.close,
          })}
        </div>
        <latexdiffs-section
          .visible=${true}
          .baseFile=${launch.baseFile}
          .baseFileOptions=${[...host.fileOptions.baseFile]}
          .editedFile=${editedFile}
          .editedFileOptions=${editedFileOptions}
          .commit=${launch.commit}
          .commitOptions=${[...host.fileOptions.commit]}
          .isGitRepo=${host.isGitRepo}
          @latexdiffs-action=${({
            detail,
          }: CustomEvent<LatexDiffsActionDetail>) =>
            this.dispatchEvent(
              SessionUiEvents.host({
                kind: 'latexdiffs',
                action: detail.action,
                baseFile: launch.baseFile,
                editedFile: editedFile || null,
                commit: launch.commit,
              }),
            )}
          @base-file-change=${({ detail }: CustomEvent<BaseFileChangeDetail>) =>
            this.setLaunch({ baseFile: detail.value })}
          @edited-file-change=${({
            detail,
          }: CustomEvent<EditedFileChangeDetail>) =>
            this.setLaunch({ editedFile: detail.value })}
          @commit-change=${({ detail }: CustomEvent<CommitChangeDetail>) =>
            this.setLaunch({ commit: detail.value })}
          @get-current-file=${({ detail }: CustomEvent<FileActionDetail>) =>
            this.dispatchEvent(
              SessionUiEvents.host({
                kind: 'useCurrentFile',
                fileType: detail.type,
              }),
            )}
          @empty-file=${({ detail }: CustomEvent<FileActionDetail>) =>
            this.emptyFile(detail.type)}
          @refresh-edited-files=${() =>
            this.dispatchEvent(SessionUiEvents.host({ kind: 'refreshFiles' }))}
          @refresh-commits=${() =>
            this.dispatchEvent(
              SessionUiEvents.host({ kind: 'refreshCommits' }),
            )}
        ></latexdiffs-section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tools-sheet': ToolsSheet;
  }
}
