// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports
import type { OutputFileInfo } from '@shared/schemas';

interface FileCommandDetail {
  command: string;
  file: string;
  base?: string;
  prev?: string;
}

@customElement('file-list')
export class FileList extends LitElement {
  @property({ type: Object })
  filesByRound: Record<string, OutputFileInfo[]> = {};

  @property({ type: Array })
  files: OutputFileInfo[] = [];

  @property({ type: Boolean })
  showRoundHeaders = true;

  createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult | null {
    const hasFiles = this.showRoundHeaders
      ? Object.keys(this.filesByRound).length > 0
      : this.files.length > 0;

    if (!hasFiles) {
      return null;
    }

    return html`
      <vscode-collapsible
        id="generatedFilesCollapsible"
        class="files-collapsible"
        title="Output files"
        open
      >
        <div id="generatedFiles" class="files-container">
          ${this.showRoundHeaders
            ? this.renderRounds()
            : this.renderFileList(this.files)}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderRounds(): TemplateResult {
    const rounds = Object.entries(this.filesByRound)
      .map(([round, files]) => [Number(round), files] as const)
      .filter(([round]) => !Number.isNaN(round))
      .sort((a, b) => a[0] - b[0]);

    return html`${repeat(
      rounds,
      ([round]) => round,
      ([round, files]) => html`
        <vscode-collapsible
          class="round-collapsible"
          title=${`Round ${round}`}
          open
        >
          ${this.renderFileList(files)}
        </vscode-collapsible>
      `,
    )}`;
  }

  private renderFileList(files: OutputFileInfo[]): TemplateResult {
    return html`${repeat(
      files,
      (file) => file.location.absolutePath,
      (file) => this.renderFileItem(file),
    )}`;
  }

  private renderFileItem(file: OutputFileInfo): TemplateResult {
    const lineageOriginalPath = this.getLocationPath(file.lineage?.original);
    const locationPath = this.getLocationPath(file.location);
    const displayPath = lineageOriginalPath || locationPath || file.source;
    const tooltipPath =
      file.location.kind === 'workspace' || file.location.kind === 'runStorage'
        ? file.location.relativePath
        : file.location.absolutePath;
    const diffStats = file.diff
      ? html`<span class="file-stats"
          ><span class="added">+${file.diff.added}</span> ${file.diff.removed !=
          null
            ? html`<span class="removed">-${file.diff.removed}</span>`
            : null}</span
        >`
      : null;

    const effectiveBase =
      file.lineage?.diffBase?.absolutePath ||
      file.lineage?.original?.absolutePath ||
      '';
    const diffBase = file.lineage?.diffBase?.absolutePath || '';

    return html`
      <div class="file-item">
        <div
          class="file-name file-path clickable-link"
          title=${tooltipPath}
          @click=${() =>
            this.emitFileCommand({
              command: 'openFile',
              file: file.location.absolutePath,
            })}
        >
          <span class="file-basename">${displayPath}</span>
          <span class="file-dir"></span>
        </div>
        ${diffStats}
        <div class="file-actions">
          ${this.renderActionButton(
            'compareOriginal',
            'diff',
            'Compare original',
            effectiveBase,
            { file: file.location.absolutePath, base: effectiveBase },
          )}
          ${this.renderActionButton(
            'comparePrevious',
            'diff-single',
            'Compare previous',
            diffBase,
            {
              file: file.location.absolutePath,
              prev: diffBase,
              base: effectiveBase,
            },
          )}
          ${this.renderActionButton(
            'acceptFile',
            'check',
            'Accept file',
            effectiveBase,
            { file: file.location.absolutePath, base: effectiveBase },
          )}
          ${this.renderActionButton(
            'mergeFile',
            'git-merge',
            'Merge file',
            effectiveBase,
            { file: file.location.absolutePath, base: effectiveBase },
          )}
          ${this.renderActionButton(
            'latexdiffFile',
            'diff-multiple',
            'LaTeXdiff',
            effectiveBase,
            { file: file.location.absolutePath, base: effectiveBase },
          )}
        </div>
      </div>
    `;
  }

  private renderActionButton(
    command: string,
    icon: string,
    title: string,
    enabledCondition: string,
    detail: Omit<FileCommandDetail, 'command'>,
  ): TemplateResult | null {
    if (!enabledCondition) return null;

    return html`
      <vscode-toolbar-button
        title=${title}
        icon=${icon}
        @click=${() => this.emitFileCommand({ command, ...detail })}
      ></vscode-toolbar-button>
    `;
  }

  private emitFileCommand(detail: FileCommandDetail) {
    this.dispatchEvent(
      new CustomEvent('file-command', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private getLocationPath(
    location: OutputFileInfo['location'] | null | undefined,
  ): string {
    if (!location) return '';
    return location.kind === 'external'
      ? location.absolutePath
      : location.relativePath;
  }
}
