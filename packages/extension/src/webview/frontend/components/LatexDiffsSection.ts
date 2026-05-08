/**
 * LatexDiffsSection component for MainView LaTeXDiff controls.
 *
 * Renders the LaTeXDiff section with base/edited file selectors,
 * commit selector, and diff action buttons.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';

// Local imports - main view
import { designTokens, codiconStyles } from '@shared/styles';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { type TeXRAIconName, waIcon } from '@shared/wa/webAwesomeIcons';
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

  private renderDatasetButton({
    id,
    icon,
    label,
    title,
    diffAction,
    fileAction,
    fileType,
  }: {
    id: string;
    icon: TeXRAIconName;
    label: string;
    title?: string;
    diffAction?: string;
    fileAction?: string;
    fileType?: string;
  }): TemplateResult {
    return html`
      <wa-button
        id=${id}
        class="action-icon-button"
        appearance="outlined"
        variant="neutral"
        size="small"
        type="button"
        aria-label=${label}
        title=${title ?? label}
        data-diff-action=${ifDefined(diffAction)}
        data-file-action=${ifDefined(fileAction)}
        data-file-type=${ifDefined(fileType)}
      >
        ${waIcon(icon)}
      </wa-button>
    `;
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
                ${this.renderDatasetButton({
                  id: 'currentBaseFileButton',
                  icon: 'file-code',
                  label: 'Set current file as base',
                  title: 'Set current file as base',
                  fileAction: 'current',
                  fileType: 'base',
                })}
                ${this.renderDatasetButton({
                  id: 'emptyBaseFileButton',
                  icon: 'close',
                  label: 'Clear base file',
                  title: 'Clear base file',
                  fileAction: 'empty',
                  fileType: 'base',
                })}
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
                ${renderIconActionButton({
                  id: 'refreshEditedFileButton',
                  icon: 'edit',
                  label: 'Refresh edited files',
                  title: 'Refresh edited files',
                  onClick: this.handleRefreshEditedFiles,
                })}
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
                ${this.renderDatasetButton({
                  id: 'acceptButton',
                  icon: 'check',
                  label: 'Accept changes',
                  title:
                    'Accept changes from edited file and overwrite base file',
                  diffAction: 'accept',
                })}
                ${this.renderDatasetButton({
                  id: 'compareButton',
                  icon: 'diff',
                  label: 'Compare files',
                  title:
                    'Compare the selected edited file with the selected base file',
                  diffAction: 'compare',
                })}
                ${this.renderDatasetButton({
                  id: 'mergeButton',
                  icon: 'merge',
                  label: 'Merge edits',
                  title:
                    'Create a new version of the base file by merging the edits suggested by the edited file',
                  diffAction: 'merge',
                })}
                ${this.renderDatasetButton({
                  id: 'latexdiffButton',
                  icon: 'diff-single',
                  label: 'LaTeXdiff',
                  title:
                    'LaTeXdiff the selected edited file with the selected base file',
                  diffAction: 'latexdiff',
                })}
                ${this.renderDatasetButton({
                  id: 'currentEditedFileButton',
                  icon: 'file-code',
                  label: 'Set current file as edited',
                  title: 'Set current file as edited',
                  fileAction: 'current',
                  fileType: 'edited',
                })}
                ${this.renderDatasetButton({
                  id: 'emptyEditedFileButton',
                  icon: 'close',
                  label: 'Clear edited file',
                  title: 'Clear edited file',
                  fileAction: 'empty',
                  fileType: 'edited',
                })}
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
                ${renderIconActionButton({
                  id: 'refreshCommitsButton',
                  icon: 'git-commit',
                  label: 'Refresh commit list',
                  title: 'Refresh commit list',
                  onClick: this.handleRefreshCommits,
                })}
                <label for="commit">Commit</label>
              </div>
              <div
                class="file-select-actions"
                @click=${this.handleToolbarClick}
              >
                ${this.renderDatasetButton({
                  id: 'latexdiffvcButton',
                  icon: 'diff-single',
                  label: 'LaTeXdiff with commit',
                  title:
                    'LaTeXdiff the selected base file with another git commit',
                  diffAction: 'latexdiffvc',
                })}
                ${this.renderDatasetButton({
                  id: 'packLatexdiffvcButton',
                  icon: 'archive',
                  label: 'Pack latexdiff output',
                  title: 'Pack the latexdiff-vc output into the History folder',
                  diffAction: 'packLatexdiffvc',
                })}
                ${this.renderDatasetButton({
                  id: 'cleanLatexdiffvcButton',
                  icon: 'trash',
                  label: 'Clean latexdiff output',
                  title: 'Clean the latexdiff-vc output',
                  diffAction: 'cleanLatexdiffvc',
                })}
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
