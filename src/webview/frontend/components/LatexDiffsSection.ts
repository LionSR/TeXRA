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
import { MainViewEvents } from '../events';
import {
  fileSelectLayoutStyles,
  toggleStyles,
} from '../styles/fileSelectStyles';

@customElement('latexdiffs-section')
export class LatexDiffsSection extends LitElement {
  static override styles = [
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
        border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
        border-radius: var(--border-radius);
        padding: var(--spacing-medium);
        overflow: visible;
      }

      .latexdiffs-section .file-select-header {
        margin-bottom: 0;
      }

      .latexdiffs-section vscode-toolbar-button {
        width: var(--height-control);
        height: var(--height-control);
        min-width: var(--height-control);
        min-height: var(--height-control);
      }

      .latexdiffs-section[data-expanded='true'] .optional-label,
      .latexdiffs-section[data-expanded='true'] .toggle-icon {
        color: var(--vscode-foreground);
      }

      #latexdiffsContent {
        overflow: visible;
      }

      #commit::part(listbox) {
        max-height: var(--height-large);
      }

      .instruction-controls {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: var(--spacing-small);
        flex-wrap: wrap;
        width: 100%;
      }
    `,
  ];

  /** Whether the section is expanded */
  @property({ type: Boolean }) visible = false;

  /** Base file value */
  @property({ type: String }) baseFile = '';

  /** Base file options */
  @property({ type: Array }) baseFileOptions: string[] = [];

  /** Edited file value */
  @property({ type: String }) editedFile = '';

  /** Edited file options */
  @property({ type: Array }) editedFileOptions: string[] = [];

  /** Commit value */
  @property({ type: String }) commit = 'HEAD';

  /** Commit options */
  @property({ type: Array }) commitOptions: string[] = [];

  /** Whether this is a git repo */
  @property({ type: Boolean }) isGitRepo = true;

  private handleToggle(): void {
    this.dispatchEvent(
      MainViewEvents.latexDiffsToggle({ visible: !this.visible }),
    );
  }

  private handleBaseFileChange(value: string): void {
    this.dispatchEvent(MainViewEvents.baseFileChange({ value }));
  }

  private handleEditedFileChange(value: string): void {
    this.dispatchEvent(MainViewEvents.editedFileChange({ value }));
  }

  private handleCommitChange(value: string): void {
    this.dispatchEvent(MainViewEvents.commitChange({ value }));
  }

  private handleGetCurrentFile(type: 'base' | 'edited'): void {
    this.dispatchEvent(MainViewEvents.getCurrentFile({ type }));
  }

  private handleEmptyFile(type: 'base' | 'edited'): void {
    this.dispatchEvent(MainViewEvents.emptyFile({ type }));
  }

  private handleRefreshEditedFiles(): void {
    this.dispatchEvent(MainViewEvents.refreshEditedFiles());
  }

  private handleRefreshCommits(): void {
    this.dispatchEvent(MainViewEvents.refreshCommits());
  }

  private handleAction(
    action:
      | 'latexdiff'
      | 'latexdiffvc'
      | 'packLatexdiffvc'
      | 'cleanLatexdiffvc'
      | 'merge'
      | 'compare'
      | 'accept',
  ): void {
    this.dispatchEvent(MainViewEvents.latexDiffsAction({ action }));
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
      return html`<vscode-option value="">Not a Git repository</vscode-option>`;
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
              <vscode-toolbar-container class="file-select-actions">
                <vscode-toolbar-button
                  id="currentBaseFileButton"
                  icon="file-code"
                  label="Set current file as base"
                  title="Set current file as base"
                  @click=${() => this.handleGetCurrentFile('base')}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="emptyBaseFileButton"
                  icon="close"
                  label="Clear base file"
                  title="Clear base file"
                  @click=${() => this.handleEmptyFile('base')}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="baseFile"
              .value=${this.baseFile}
              @change=${(event: Event) => {
                const target = event.currentTarget as HTMLInputElement;
                this.handleBaseFileChange(target.value);
              }}
            >
              ${this.renderFileOptions(this.baseFileOptions, this.baseFile)}
            </vscode-single-select>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="editedFile">Edited</label>
              </div>
              <vscode-toolbar-container class="file-select-actions">
                <vscode-toolbar-button
                  id="refreshEditedFileButton"
                  icon="edit"
                  label="Refresh edited files"
                  title="Refresh edited files"
                  @click=${this.handleRefreshEditedFiles}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="currentEditedFileButton"
                  icon="file-code"
                  label="Set current file as edited"
                  title="Set current file as edited"
                  @click=${() => this.handleGetCurrentFile('edited')}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="emptyEditedFileButton"
                  icon="close"
                  label="Clear edited file"
                  title="Clear edited file"
                  @click=${() => this.handleEmptyFile('edited')}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="editedFile"
              .value=${this.editedFile}
              @change=${(event: Event) => {
                const target = event.currentTarget as HTMLInputElement;
                this.handleEditedFileChange(target.value);
              }}
            >
              ${this.renderFileOptions(this.editedFileOptions, this.editedFile)}
            </vscode-single-select>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="commit">
                  <i class="codicon codicon-git-commit"></i> Commit
                </label>
              </div>
              <vscode-toolbar-container class="file-select-actions">
                <vscode-toolbar-button
                  id="refreshCommitsButton"
                  icon="refresh"
                  label="Refresh commits"
                  title="Refresh commits"
                  @click=${this.handleRefreshCommits}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="commit"
              .value=${this.commit}
              ?disabled=${!this.isGitRepo}
              @change=${(event: Event) => {
                const target = event.currentTarget as HTMLInputElement;
                this.handleCommitChange(target.value);
              }}
            >
              ${this.renderCommitOptions()}
            </vscode-single-select>
          </div>
          <div class="instruction-controls">
            <vscode-toolbar-button
              id="latexdiffButton"
              icon="compare-changes"
              label="Run LaTeXDiff"
              title="Run LaTeXDiff"
              @click=${() => this.handleAction('latexdiff')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="latexdiffvcButton"
              icon="compare-changes"
              label="Run LaTeXDiff with version control"
              title="Run LaTeXDiff with version control"
              @click=${() => this.handleAction('latexdiffvc')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="packLatexdiffvcButton"
              icon="archive"
              label="Pack LaTeXDiff VC"
              title="Pack LaTeXDiff VC"
              @click=${() => this.handleAction('packLatexdiffvc')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="cleanLatexdiffvcButton"
              icon="trash"
              label="Clean LaTeXDiff VC"
              title="Clean LaTeXDiff VC"
              @click=${() => this.handleAction('cleanLatexdiffvc')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="mergeButton"
              icon="merge"
              label="Merge edits"
              title="Merge edits"
              @click=${() => this.handleAction('merge')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="compareButton"
              icon="diff"
              label="Compare"
              title="Compare"
              @click=${() => this.handleAction('compare')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="acceptButton"
              icon="check"
              label="Accept"
              title="Accept"
              @click=${() => this.handleAction('accept')}
            ></vscode-toolbar-button>
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
