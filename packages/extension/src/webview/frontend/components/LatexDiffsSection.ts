/**
 * LatexDiffsSection component for MainView LaTeXDiff controls.
 *
 * Renders the LaTeXDiff section with base/edited file selectors,
 * commit selector, and diff action buttons.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';

// Local imports - main view
import { designTokens, codiconStyles } from '@shared/styles';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { MainViewEvents } from '../events';
import {
  fileSelectLayoutStyles,
  toggleStyles,
} from '../styles/fileSelectStyles';

@customElement('latexdiffs-section')
export class LatexDiffsSection extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    fileSelectLayoutStyles,
    toggleStyles,
    css`
      :host {
        display: block;
      }

      .latexdiffs-section {
        margin-top: auto;
        padding: var(--spacing-large) 0 0;
        background-color: transparent;
        border: none;
        margin-bottom: var(--spacing-large);
      }

      .latexdiffs-section[data-expanded='true'] {
        background-color: var(--background-color);
        border: var(--border-thin) solid
          var(--texra-widget-border, var(--dropdown-border));
        border-radius: var(--border-radius);
        padding: var(--spacing-medium);
        overflow: visible;
      }

      .latexdiffs-section .file-select-header {
        margin-bottom: 0;
      }

      .latexdiffs-section wa-button {
        width: var(--height-control);
        height: var(--height-control);
        min-width: var(--height-control);
        min-height: var(--height-control);
      }

      .latexdiffs-section[data-expanded='true'] .optional-label,
      .latexdiffs-section[data-expanded='true'] .toggle-icon {
        color: var(--texra-foreground);
      }

      #latexdiffsContent {
        overflow: visible;
      }

      #commit::part(listbox) {
        max-height: var(--height-large);
      }
    `,
  ];

  /** Whether the section is expanded */
  @property({ attribute: false }) visible = false;

  /** Base file value */
  @property({ attribute: false }) baseFile = '';

  /** Base file options */
  @property({ attribute: false }) baseFileOptions: string[] = [];

  /** Edited file value */
  @property({ attribute: false }) editedFile = '';

  /** Edited file options */
  @property({ attribute: false }) editedFileOptions: string[] = [];

  /** Commit value */
  @property({ attribute: false }) commit = 'HEAD';

  /** Commit options */
  @property({ attribute: false }) commitOptions: string[] = [];

  /** Whether this is a git repo */
  @property({ attribute: false }) isGitRepo = true;

  private handleToggle(): void {
    this.dispatchEvent(
      MainViewEvents.latexDiffsToggle({ visible: !this.visible }),
    );
  }

  private handleBaseSelectChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    this.dispatchEvent(MainViewEvents.baseFileChange({ value }));
  }

  private handleEditedSelectChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    this.dispatchEvent(MainViewEvents.editedFileChange({ value }));
  }

  private handleCommitSelectChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    this.dispatchEvent(MainViewEvents.commitChange({ value }));
  }

  private handleRefreshEditedFiles(): void {
    this.dispatchEvent(MainViewEvents.refreshEditedFiles());
  }

  private handleRefreshCommits(): void {
    this.dispatchEvent(MainViewEvents.refreshCommits());
  }

  /**
   * Combined delegation handler for toolbar buttons.
   * Routes to the appropriate action based on `data-diff-action` or `data-file-action`.
   */
  private handleToolbarClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;

    const diffButton = target.closest<HTMLElement>('[data-diff-action]');
    if (diffButton?.dataset.diffAction) {
      this.dispatchEvent(
        MainViewEvents.latexDiffsAction({
          action: diffButton.dataset.diffAction as
            | 'latexdiff'
            | 'latexdiffvc'
            | 'packLatexdiffvc'
            | 'cleanLatexdiffvc'
            | 'merge'
            | 'compare'
            | 'accept',
        }),
      );
      return;
    }

    const fileButton = target.closest<HTMLElement>(
      '[data-file-action][data-file-type]',
    );
    if (!fileButton) return;
    const fileAction = fileButton.dataset.fileAction;
    const fileType = fileButton.dataset.fileType as
      | 'base'
      | 'edited'
      | undefined;
    if (!fileType) return;
    if (fileAction === 'current') {
      this.dispatchEvent(MainViewEvents.getCurrentFile({ type: fileType }));
    } else if (fileAction === 'empty') {
      this.dispatchEvent(MainViewEvents.emptyFile({ type: fileType }));
    }
  }

  private renderFileOptions(
    options: string[],
    selectedValue: string,
  ): TemplateResult {
    const sortedOptions = [...options].sort((a, b) => a.localeCompare(b));
    return html`
      <vscode-option value="" ?selected=${selectedValue === ''}
        >None</vscode-option
      >
      ${repeat(
        sortedOptions,
        (opt) => opt,
        (opt) => html`
          <vscode-option value=${opt} ?selected=${opt === selectedValue}>
            ${opt}
          </vscode-option>
        `,
      )}
    `;
  }

  private renderCommitOptions(): TemplateResult {
    if (!this.isGitRepo) {
      return html`<vscode-option value="" selected
        >Not a Git repository</vscode-option
      >`;
    }
    const entries = this.commitOptions.some((commit) =>
      commit.startsWith('HEAD'),
    )
      ? this.commitOptions
      : ['HEAD', ...this.commitOptions];
    return html`
      ${repeat(
        entries,
        (commit) => commit,
        (commit) => {
          const [hash] = commit.split(': ');
          return html`
            <vscode-option value=${hash} ?selected=${hash === this.commit}>
              ${commit}
            </vscode-option>
          `;
        },
      )}
    `;
  }

  override render(): TemplateResult {
    const chevronClass = this.visible
      ? 'codicon-chevron-up'
      : 'codicon-chevron-down';

    return html`
      <div class="latexdiffs-section" data-expanded=${String(this.visible)}>
        <div class="file-select-header">
          <div class="file-select-label-group">
            <span
              id="toggleLatexdiffs"
              class="toggle-icon"
              title="LaTeXDiffs"
              @click=${this.handleToggle}
            >
              <i class="codicon ${chevronClass}"></i>
            </span>
            <span class="optional-label"
              ><i class="codicon codicon-source-control"></i> LaTeXDiffs</span
            >
          </div>
        </div>
        <div
          id="latexdiffsContent"
          style=${styleMap({ display: this.visible ? 'block' : 'none' })}
        >
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="baseFile">Base</label>
              </div>
              <div
                class="file-select-actions"
                @click=${this.handleToolbarClick}
              >
                <span id="currentBaseFileButton">
                  ${renderIconActionButton({
                    icon: 'file-code',
                    label: 'Set current file as base',
                    title: 'Set current file as base',
                    dataset: { fileAction: 'current', fileType: 'base' },
                  })}
                </span>
                <span id="emptyBaseFileButton">
                  ${renderIconActionButton({
                    icon: 'close',
                    label: 'Clear base file',
                    title: 'Clear base file',
                    dataset: { fileAction: 'empty', fileType: 'base' },
                  })}
                </span>
              </div>
            </div>
            <vscode-single-select
              id="baseFile"
              position="above"
              .value=${this.baseFile}
              @change=${this.handleBaseSelectChange}
            >
              ${this.renderFileOptions(this.baseFileOptions, this.baseFile)}
            </vscode-single-select>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <span id="refreshEditedFileButton">
                  ${renderIconActionButton({
                    icon: 'edit',
                    label: 'Refresh edited files',
                    title: 'Refresh edited files',
                    onClick: this.handleRefreshEditedFiles,
                  })}
                </span>
                <label
                  for="editedFile"
                  title="File containing edits to merge into the base file"
                >
                  Edited
                </label>
              </div>
              <div
                class="file-select-actions"
                @click=${this.handleToolbarClick}
              >
                <span id="acceptButton">
                  ${renderIconActionButton({
                    icon: 'check',
                    label: 'Accept changes',
                    title:
                      'Accept changes from edited file and overwrite base file',
                    dataset: { diffAction: 'accept' },
                  })}
                </span>
                <span id="compareButton">
                  ${renderIconActionButton({
                    icon: 'diff',
                    label: 'Compare files',
                    title:
                      'Compare the selected edited file with the selected base file',
                    dataset: { diffAction: 'compare' },
                  })}
                </span>
                <span id="mergeButton">
                  ${renderIconActionButton({
                    icon: 'merge',
                    label: 'Merge edits',
                    title:
                      'Create a new version of the base file by merging the edits suggested by the edited file',
                    dataset: { diffAction: 'merge' },
                  })}
                </span>
                <span id="latexdiffButton">
                  ${renderIconActionButton({
                    icon: 'diff-single',
                    label: 'LaTeXdiff',
                    title:
                      'LaTeXdiff the selected edited file with the selected base file',
                    dataset: { diffAction: 'latexdiff' },
                  })}
                </span>
                <span id="currentEditedFileButton">
                  ${renderIconActionButton({
                    icon: 'file-code',
                    label: 'Set current file as edited',
                    title: 'Set current file as edited',
                    dataset: { fileAction: 'current', fileType: 'edited' },
                  })}
                </span>
                <span id="emptyEditedFileButton">
                  ${renderIconActionButton({
                    icon: 'close',
                    label: 'Clear edited file',
                    title: 'Clear edited file',
                    dataset: { fileAction: 'empty', fileType: 'edited' },
                  })}
                </span>
              </div>
            </div>
            <vscode-single-select
              id="editedFile"
              position="above"
              .value=${this.editedFile}
              @change=${this.handleEditedSelectChange}
            >
              ${this.renderFileOptions(this.editedFileOptions, this.editedFile)}
            </vscode-single-select>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <span id="refreshCommitsButton">
                  ${renderIconActionButton({
                    icon: 'git-commit',
                    label: 'Refresh commit list',
                    title: 'Refresh commit list',
                    onClick: this.handleRefreshCommits,
                  })}
                </span>
                <label for="commit">Commit</label>
              </div>
              <div
                class="file-select-actions"
                @click=${this.handleToolbarClick}
              >
                <span id="latexdiffvcButton">
                  ${renderIconActionButton({
                    icon: 'diff-single',
                    label: 'LaTeXdiff with commit',
                    title:
                      'LaTeXdiff the selected base file with another git commit',
                    dataset: { diffAction: 'latexdiffvc' },
                  })}
                </span>
                <span id="packLatexdiffvcButton">
                  ${renderIconActionButton({
                    icon: 'archive',
                    label: 'Pack latexdiff output',
                    title:
                      'Pack the latexdiff-vc output into the History folder',
                    dataset: { diffAction: 'packLatexdiffvc' },
                  })}
                </span>
                <span id="cleanLatexdiffvcButton">
                  ${renderIconActionButton({
                    icon: 'trash',
                    label: 'Clean latexdiff output',
                    title: 'Clean the latexdiff-vc output',
                    dataset: { diffAction: 'cleanLatexdiffvc' },
                  })}
                </span>
              </div>
            </div>
            <vscode-single-select
              id="commit"
              position="above"
              .value=${this.commit}
              ?disabled=${!this.isGitRepo}
              @change=${this.handleCommitSelectChange}
            >
              ${this.renderCommitOptions()}
            </vscode-single-select>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'latexdiffs-section': LatexDiffsSection;
  }
}
