// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local types
import type { OutputFileInfo } from '@shared/schemas';

@customElement('file-list')
export class FileList extends LitElement {
  @property({ type: Object }) filesByRound: Record<string, OutputFileInfo[]> =
    {};
  @property({ type: Boolean }) showRoundHeaders = true;
  @property({ type: Boolean }) visible = false;

  @state() private sortedRounds: [number, OutputFileInfo[]][] = [];

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override willUpdate(changedProps: Map<PropertyKey, unknown>): void {
    if (changedProps.has('filesByRound')) {
      this.sortedRounds = Object.entries(this.filesByRound)
        .map(
          ([round, files]) =>
            [Number(round), files] as [number, OutputFileInfo[]],
        )
        .sort((a, b) => a[0] - b[0]);
    }
  }

  private renderFileActions(file: OutputFileInfo, basePath?: string) {
    const filePath = file.location.absolutePath;
    const diffBase = file.lineage?.diffBase?.absolutePath;

    const actionButton = (
      className: string,
      command: string,
      title: string,
      icon: string,
      dataset: Record<string, string | undefined>,
      enabled: boolean,
    ) => {
      if (!enabled) return null;
      return html`
        <vscode-toolbar-button
          class=${className}
          icon=${icon}
          title=${title}
          data-command=${command}
          data-file=${dataset.file ?? ''}
          data-base=${dataset.base ?? ''}
          data-prev=${dataset.prev ?? ''}
        ></vscode-toolbar-button>
      `;
    };

    return html`
      <div class="file-actions">
        ${actionButton(
          'compare-btn',
          PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL,
          'Compare against original',
          'diff',
          { file: filePath, base: basePath },
          Boolean(basePath),
        )}
        ${actionButton(
          'accept-btn',
          PROGRESS_VIEW_COMMANDS.ACCEPT_FILE,
          'Accept change',
          'check',
          { file: filePath, base: basePath },
          Boolean(basePath),
        )}
        ${actionButton(
          'merge-btn',
          PROGRESS_VIEW_COMMANDS.MERGE_FILE,
          'Merge changes',
          'merge',
          { file: filePath, base: basePath },
          Boolean(basePath),
        )}
        ${actionButton(
          'diff-btn',
          PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE,
          'Run latexdiff',
          'diff-multiple',
          { file: filePath, base: basePath },
          Boolean(basePath),
        )}
        ${actionButton(
          'prev-btn',
          PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS,
          'Compare against previous',
          'history',
          { file: filePath, prev: diffBase, base: basePath },
          Boolean(diffBase),
        )}
      </div>
    `;
  }

  private renderFileStats(file: OutputFileInfo) {
    if (file.diff?.added == null) return null;
    return html`
      <span class="file-stats">
        <span class="added">+${file.diff.added}</span>
        ${file.diff.removed != null
          ? html`<span class="removed">-${file.diff.removed}</span>`
          : null}
      </span>
    `;
  }

  private renderFileItem(file: OutputFileInfo) {
    const { location } = file;
    const relativePath =
      location.kind === 'external' ? undefined : location.relativePath;
    const originalRelativePath =
      file.lineage?.original?.kind === 'external'
        ? undefined
        : file.lineage?.original?.relativePath;
    const displayPath = originalRelativePath || relativePath || file.source;
    const tooltipPath =
      location.kind === 'external'
        ? location.absolutePath
        : location.relativePath;
    const basePath =
      file.lineage?.diffBase?.absolutePath ||
      file.lineage?.original?.absolutePath;

    return html`
      <div
        class="file-item"
        data-file=${location.absolutePath}
        data-original=${file.lineage?.original?.absolutePath ?? ''}
        data-base=${file.lineage?.diffBase?.absolutePath ?? ''}
        data-workspace=${location.kind === 'workspace'
          ? location.absolutePath
          : ''}
        data-relative=${location.kind === 'workspace' ||
        location.kind === 'runStorage'
          ? location.relativePath
          : ''}
      >
        <span class="file-name">
          <span
            class="file-path clickable-link"
            title=${tooltipPath ?? ''}
            data-command=${PROGRESS_VIEW_COMMANDS.OPEN_FILE}
            data-file=${location.absolutePath}
          >
            <span class="file-basename">${displayPath}</span>
            <span class="file-dir"></span>
          </span>
          ${this.renderFileStats(file)}
        </span>
        ${this.renderFileActions(file, basePath)}
      </div>
    `;
  }

  override render() {
    if (!this.visible || this.sortedRounds.length === 0) {
      return html`
        <vscode-collapsible
          id="generatedFilesCollapsible"
          class="files-collapsible"
          title="Generated files"
          hidden
        ></vscode-collapsible>
      `;
    }

    return html`
      <vscode-collapsible
        id="generatedFilesCollapsible"
        class="files-collapsible"
        title="Generated files"
      >
        <div class="files-container" id="generatedFiles">
          ${this.showRoundHeaders
            ? repeat(
                this.sortedRounds,
                ([round]) => round,
                ([round, files]) => html`
                  <vscode-collapsible
                    class="round-collapsible"
                    title=${`r${round}`}
                  >
                    ${repeat(
                      files,
                      (file) => file.location.absolutePath,
                      (file) => this.renderFileItem(file),
                    )}
                  </vscode-collapsible>
                `,
              )
            : repeat(
                this.sortedRounds.flatMap(([, files]) => files),
                (file) => file.location.absolutePath,
                (file) => this.renderFileItem(file),
              )}
        </div>
      </vscode-collapsible>
    `;
  }
}
