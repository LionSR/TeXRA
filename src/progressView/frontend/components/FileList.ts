// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - progress view constants
import { COMMANDS, ELEMENT_IDS } from '../constants';
import { ProgressEvents } from '../events';

// Local imports - shared schemas
import type { OutputFileInfo } from '@shared/schemas';

@customElement('file-list')
export class FileList extends LitElement {
  @property({ type: Object }) filesByRound: Record<string, OutputFileInfo[]> =
    {};
  @property({ type: Boolean }) showRoundHeaders = true;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    const rounds = this.getSortedRounds();
    const hasFiles = rounds.length > 0;

    return html`
      <vscode-collapsible
        id=${ELEMENT_IDS.GENERATED_FILES_COLLAPSIBLE}
        class="files-collapsible progress-collapsible"
        title="Generated files"
        ?open=${hasFiles}
        ?hidden=${!hasFiles}
        aria-hidden=${hasFiles ? 'false' : 'true'}
      >
        <div id=${ELEMENT_IDS.GENERATED_FILES} class="files-container">
          ${repeat(
            rounds,
            ([round]) => round,
            ([round, files]) => this.renderRound(round, files),
          )}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderRound(round: number, files: OutputFileInfo[]): TemplateResult {
    if (!this.showRoundHeaders) {
      return html`${files.map((file) => this.renderFileItem(file))}`;
    }

    return html`
      <vscode-collapsible
        class="round-collapsible progress-collapsible"
        title=${`r${round}`}
        ?open=${true}
      >
        <div class="round-content">
          ${files.map((file) => this.renderFileItem(file))}
        </div>
      </vscode-collapsible>
    `;
  }

  private renderFileItem(file: OutputFileInfo): TemplateResult | typeof nothing {
    if (!file?.location) return nothing;

    const location = file.location;
    const relativePath = this.getDisplayPath(location);
    const originalRelativePath = file.lineage?.original
      ? this.getDisplayPath(file.lineage.original)
      : undefined;
    const displayPath = originalRelativePath ?? relativePath;
    const normalizedPath = displayPath.replaceAll('\\', '/');
    const lastSlash = normalizedPath.lastIndexOf('/');
    const basename =
      lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
    const dir = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash + 1) : '';
    const tooltipPath = this.getDisplayPath(location);
    const effectiveBase =
      file.lineage?.diffBase?.absolutePath ??
      file.lineage?.original?.absolutePath ??
      '';
    const diffBase = file.lineage?.diffBase?.absolutePath;

    return html`
      <div
        class="file-item"
        data-file=${location.absolutePath}
        data-original=${file.lineage?.original?.absolutePath || ''}
        data-base=${file.lineage?.diffBase?.absolutePath || ''}
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
            title=${tooltipPath}
            @click=${() =>
              this.emitFileAction(COMMANDS.OPEN_FILE, {
                file: location.absolutePath,
              })}
          >
            <span class="file-basename">${basename}</span>
            <span class="file-dir">${dir}</span>
          </span>
        </span>
        ${when(
          file.diff?.added !== undefined,
          () => html`
            <span class="file-stats">
              <span class="added">+${file.diff!.added}</span>
              ${when(
                file.diff!.removed !== undefined,
                () => html`<span class="removed">-${file.diff!.removed}</span>`,
              )}
            </span>
          `,
        )}
        <div class="file-actions">
          ${when(
            effectiveBase,
            () => html`
              <vscode-toolbar-button
                class="compare-btn"
                icon="diff"
                title="Compare with original"
                @click=${() =>
                  this.emitFileAction(COMMANDS.COMPARE_ORIGINAL, {
                    file: location.absolutePath,
                    base: effectiveBase,
                  })}
              ></vscode-toolbar-button>
              <vscode-toolbar-button
                class="accept-btn"
                icon="pass"
                title="Accept output"
                @click=${() =>
                  this.emitFileAction(COMMANDS.ACCEPT_FILE, {
                    file: location.absolutePath,
                    base: effectiveBase,
                  })}
              ></vscode-toolbar-button>
              <vscode-toolbar-button
                class="merge-btn"
                icon="git-merge"
                title="Merge changes"
                @click=${() =>
                  this.emitFileAction(COMMANDS.MERGE_FILE, {
                    file: location.absolutePath,
                    base: effectiveBase,
                  })}
              ></vscode-toolbar-button>
              <vscode-toolbar-button
                class="diff-btn"
                icon="diff-multiple"
                title="Run latexdiff"
                @click=${() =>
                  this.emitFileAction(COMMANDS.LATEXDIFF_FILE, {
                    file: location.absolutePath,
                    base: effectiveBase,
                  })}
              ></vscode-toolbar-button>
            `,
          )}
          ${when(
            diffBase,
            () => html`
              <vscode-toolbar-button
                class="prev-btn"
                icon="history"
                title="Compare with previous"
                @click=${() =>
                  this.emitFileAction(COMMANDS.COMPARE_PREVIOUS, {
                    file: location.absolutePath,
                    prev: diffBase!,
                    ...(effectiveBase ? { base: effectiveBase } : {}),
                  })}
              ></vscode-toolbar-button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private emitFileAction(
    command: string,
    payload: Record<string, string>,
  ): void {
    this.dispatchEvent(ProgressEvents.fileAction({ command, ...payload }));
  }

  private getSortedRounds(): [number, OutputFileInfo[]][] {
    return Object.entries(this.filesByRound)
      .map(
        ([round, files]) =>
          [Number(round), files] as [number, OutputFileInfo[]],
      )
      .filter(
        ([round, files]) =>
          !Number.isNaN(round) && Array.isArray(files) && files.length > 0,
      )
      .sort((a, b) => a[0] - b[0]);
  }

  private getDisplayPath(loc: OutputFileInfo['location']): string {
    if (!loc) return '';
    return loc.kind === 'workspace' || loc.kind === 'runStorage'
      ? loc.relativePath
      : loc.absolutePath;
  }
}
