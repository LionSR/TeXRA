// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { mainViewStyles } from '@webview/frontend/styles';

export type LatexDiffsAction =
  | 'toggle'
  | 'current-base'
  | 'empty-base'
  | 'refresh-edited'
  | 'current-edited'
  | 'empty-edited'
  | 'refresh-commits'
  | 'run-latexdiff'
  | 'run-latexdiffvc'
  | 'pack-latexdiffvc'
  | 'clean-latexdiffvc'
  | 'merge'
  | 'compare'
  | 'accept';

export type LatexDiffsField = 'base' | 'edited' | 'commit';

export interface LatexDiffsActionDetail {
  action: LatexDiffsAction;
}

export interface LatexDiffsChangeDetail {
  field: LatexDiffsField;
  value: string;
}

@customElement('latexdiffs-section')
export class LatexDiffsSection extends LitElement {
  static styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    mainViewStyles,
  ];

  @property({ type: Boolean }) visible = false;
  @property({ type: String }) baseFile = '';
  @property({ type: String }) editedFile = '';
  @property({ type: String }) commit = '';
  @property({ type: Boolean }) isGitRepo = true;
  @property({ type: String }) baseOptionsHtml = '';
  @property({ type: String }) editedOptionsHtml = '';
  @property({ type: String }) commitOptionsHtml = '';

  private emitAction(action: LatexDiffsAction): void {
    this.dispatchEvent(
      new CustomEvent<LatexDiffsActionDetail>('latexdiffs-action', {
        detail: { action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitChange(field: LatexDiffsField, value: string): void {
    this.dispatchEvent(
      new CustomEvent<LatexDiffsChangeDetail>('latexdiffs-change', {
        detail: { field, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleActionClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action as LatexDiffsAction | undefined;
    if (!action) return;
    this.emitAction(action);
  };

  private handleBaseChange = (event: Event): void => {
    const target = event.currentTarget as HTMLInputElement | null;
    if (!target) return;
    this.emitChange('base', target.value);
  };

  private handleEditedChange = (event: Event): void => {
    const target = event.currentTarget as HTMLInputElement | null;
    if (!target) return;
    this.emitChange('edited', target.value);
  };

  private handleCommitChange = (event: Event): void => {
    const target = event.currentTarget as HTMLInputElement | null;
    if (!target) return;
    this.emitChange('commit', target.value);
  };

  render(): TemplateResult {
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
              data-action="toggle"
              @click=${this.handleActionClick}
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
          style=${this.visible ? 'display: block' : 'display: none'}
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
                  data-action="current-base"
                  @click=${this.handleActionClick}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="emptyBaseFileButton"
                  icon="close"
                  label="Clear base file"
                  title="Clear base file"
                  data-action="empty-base"
                  @click=${this.handleActionClick}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="baseFile"
              .value=${this.baseFile}
              @change=${this.handleBaseChange}
            >
              ${unsafeHTML(this.baseOptionsHtml)}
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
                  data-action="refresh-edited"
                  @click=${this.handleActionClick}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="currentEditedFileButton"
                  icon="file-code"
                  label="Set current file as edited"
                  title="Set current file as edited"
                  data-action="current-edited"
                  @click=${this.handleActionClick}
                ></vscode-toolbar-button>
                <vscode-toolbar-button
                  id="emptyEditedFileButton"
                  icon="close"
                  label="Clear edited file"
                  title="Clear edited file"
                  data-action="empty-edited"
                  @click=${this.handleActionClick}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="editedFile"
              .value=${this.editedFile}
              @change=${this.handleEditedChange}
            >
              ${unsafeHTML(this.editedOptionsHtml)}
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
                  data-action="refresh-commits"
                  @click=${this.handleActionClick}
                ></vscode-toolbar-button>
              </vscode-toolbar-container>
            </div>
            <vscode-single-select
              id="commit"
              .value=${this.commit}
              ?disabled=${!this.isGitRepo}
              @change=${this.handleCommitChange}
            >
              ${unsafeHTML(this.commitOptionsHtml)}
            </vscode-single-select>
          </div>
          <div class="instruction-controls">
            <vscode-toolbar-button
              id="latexdiffButton"
              icon="compare-changes"
              label="Run LaTeXDiff"
              title="Run LaTeXDiff"
              data-action="run-latexdiff"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="latexdiffvcButton"
              icon="compare-changes"
              label="Run LaTeXDiff with version control"
              title="Run LaTeXDiff with version control"
              data-action="run-latexdiffvc"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="packLatexdiffvcButton"
              icon="archive"
              label="Pack LaTeXDiff VC"
              title="Pack LaTeXDiff VC"
              data-action="pack-latexdiffvc"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="cleanLatexdiffvcButton"
              icon="trash"
              label="Clean LaTeXDiff VC"
              title="Clean LaTeXDiff VC"
              data-action="clean-latexdiffvc"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="mergeButton"
              icon="merge"
              label="Merge edits"
              title="Merge edits"
              data-action="merge"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="compareButton"
              icon="diff"
              label="Compare"
              title="Compare"
              data-action="compare"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              id="acceptButton"
              icon="check"
              label="Accept"
              title="Accept"
              data-action="accept"
              @click=${this.handleActionClick}
            ></vscode-toolbar-button>
          </div>
        </div>
      </div>
    `;
  }
}
