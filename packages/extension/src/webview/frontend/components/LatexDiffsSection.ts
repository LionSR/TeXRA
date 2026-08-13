/** LaTeXDiff section with base/edited file selectors, commit selector, and diff actions. */

// Side-effect imports - register WA button, button-group, details, select, option & tooltip components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - main view
import type { LatexDiffsActionDetail } from '@shared/schemas';
import { compactFormControlStyles, designTokens } from '@shared/styles';
import { buttonStyles } from '@shared/styles/controlStyles';
import { readSelectValue } from '@shared/utils/selectTemplates';
import {
  renderIconActionButton,
  renderLabeledActionButtonParts,
} from '@shared/wa/actionButtons';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { byString } from '@utils/core';
import { MainViewEvents } from '../events';
import { fileSelectLayoutStyles } from '../fileSelectStyles';

type LatexDiffsAction = LatexDiffsActionDetail['action'];

/** A labeled diff operation button rendered inside a wa-button-group. */
interface DiffActionSpec {
  readonly id: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly tooltip: string;
  readonly action: LatexDiffsAction;
}

/** Review the base ↔ edited pair without touching either file. */
const EDITED_REVIEW_ACTIONS: readonly DiffActionSpec[] = [
  {
    id: 'latexdiffButton',
    icon: 'plus-minus',
    label: 'Diff',
    tooltip:
      'Run latexdiff on the base and edited files and open the marked-up result',
    action: 'latexdiff',
  },
  {
    id: 'compareButton',
    icon: 'code-compare',
    label: 'Compare',
    tooltip: 'Open the base and edited files side by side in the diff editor',
    action: 'compare',
  },
];

/** Apply the edited file's changes onto the base file. */
const EDITED_APPLY_ACTIONS: readonly DiffActionSpec[] = [
  {
    id: 'mergeButton',
    icon: 'code-merge',
    label: 'Merge',
    tooltip:
      'Create a new version of the base file by merging the edits suggested by the edited file',
    action: 'merge',
  },
  {
    id: 'acceptButton',
    icon: 'check',
    label: 'Accept',
    tooltip:
      'Accept the changes from the edited file and overwrite the base file',
    action: 'accept',
  },
];

/** Diff the base file against its version at the selected commit. */
const COMMIT_DIFF_ACTIONS: readonly DiffActionSpec[] = [
  {
    id: 'latexdiffvcButton',
    icon: 'plus-minus',
    label: 'Diff',
    tooltip:
      'Run latexdiff-vc on the base file against its version at the selected commit',
    action: 'latexdiffvc',
  },
];

/** Manage the artifacts a latexdiff-vc run leaves behind. */
const COMMIT_MANAGE_ACTIONS: readonly DiffActionSpec[] = [
  {
    id: 'packLatexdiffvcButton',
    icon: 'box-archive',
    label: 'Pack',
    tooltip: 'Pack the latexdiff-vc output into the History folder',
    action: 'packLatexdiffvc',
  },
  {
    id: 'cleanLatexdiffvcButton',
    icon: 'trash',
    label: 'Clean',
    tooltip: 'Delete the latexdiff-vc output files',
    action: 'cleanLatexdiffvc',
  },
];

@customElement('latexdiffs-section')
export class LatexDiffsSection extends LitElement {
  static override styles = [
    designTokens,
    buttonStyles,
    compactFormControlStyles,
    fileSelectLayoutStyles,
    css`
      :host {
        display: block;
      }

      .latexdiffs-details {
        margin-bottom: var(--wa-space-s);
      }

      .latexdiffs-details::part(base) {
        background-color: transparent;
        border: none;
        border-radius: var(--border-radius);
        overflow: visible;
      }

      .latexdiffs-details[open]::part(base) {
        background-color: var(--background-color);
        border: var(--border-thin) solid
          var(--wa-color-surface-border, var(--dropdown-border));
      }

      .latexdiffs-details::part(header) {
        padding: var(--wa-space-s) var(--wa-space-xs) 0;
        min-height: var(--height-control-compact);
      }

      .latexdiffs-details[open]::part(header) {
        padding: var(--wa-space-xs) var(--wa-space-xs) var(--wa-space-3xs);
      }

      .latexdiffs-details::part(content) {
        padding: 0 var(--wa-space-xs) var(--wa-space-xs);
        overflow: visible;
      }

      .latexdiffs-summary {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        color: var(--text-color);
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
        white-space: nowrap;
      }

      .latexdiffs-details[open] .latexdiffs-summary {
        color: var(--wa-color-text-normal);
      }

      #commit::part(listbox) {
        max-height: var(--height-large);
      }

      /* Operation rows: native small WA buttons in button groups beneath the
         select they act on. Density comes from WA's published form-control
         tokens, not ::part overrides, so hover/focus/active chrome stays
         stock Web Awesome. */
      .diff-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
      }

      .diff-actions wa-button {
        font-size: var(--font-size-sm);
        --wa-form-control-height: var(--height-control);
        --wa-form-control-padding-inline: var(--wa-space-xs);
      }

      .diff-actions wa-button wa-icon {
        font-size: var(--font-size-xs);
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

  private handleDetailsOpenChange(event: Event, visible: boolean): void {
    if (event.target !== event.currentTarget) return;
    this.dispatchEvent(MainViewEvents.latexDiffsToggle({ visible }));
  }

  private handleBaseSelectChange(event: Event): void {
    this.dispatchEvent(
      MainViewEvents.baseFileChange({ value: readSelectValue(event) }),
    );
  }

  private handleEditedSelectChange(event: Event): void {
    this.dispatchEvent(
      MainViewEvents.editedFileChange({ value: readSelectValue(event) }),
    );
  }

  private handleCommitSelectChange(event: Event): void {
    this.dispatchEvent(
      MainViewEvents.commitChange({ value: readSelectValue(event) }),
    );
  }

  private handleRefreshEditedFiles(): void {
    this.dispatchEvent(MainViewEvents.refreshEditedFiles());
  }

  private handleRefreshCommits(): void {
    this.dispatchEvent(MainViewEvents.refreshCommits());
  }

  /**
   * A cluster of labeled operation buttons. Tooltips render after the group:
   * wa-button-group fuses corners via CSS :first/:last-child on its slotted
   * children, so a slotted wa-tooltip would break the segmenting — hence
   * `renderLabeledActionButtonParts` rather than the concatenated
   * `renderLabeledActionButton`.
   */
  private renderDiffActionGroup(
    label: string,
    actions: readonly DiffActionSpec[],
  ): TemplateResult {
    const parts = actions.map((action) => ({
      id: action.id,
      ...renderLabeledActionButtonParts({
        id: action.id,
        icon: action.icon,
        text: action.label,
        tooltip: action.tooltip,
        appearance: 'outlined',
        onClick: () =>
          this.dispatchEvent(
            MainViewEvents.latexDiffsAction({ action: action.action }),
          ),
      }),
    }));
    return html`
      <wa-button-group label=${label}>
        ${repeat(
          parts,
          (part) => part.id,
          (part) => part.button,
        )}
      </wa-button-group>
      ${repeat(
        parts,
        (part) => part.id,
        (part) => part.tooltip,
      )}
    `;
  }

  private renderFileOptions(options: string[]): TemplateResult {
    const sortedOptions = options.toSorted(byString);
    return html`
      <wa-option value="">None</wa-option>
      ${repeat(
        sortedOptions,
        (opt) => opt,
        (opt) => html` <wa-option value=${opt}> ${opt} </wa-option> `,
      )}
    `;
  }

  private renderCommitOptions(): TemplateResult {
    if (!this.isGitRepo) {
      return html`<wa-option value="">Not a Git repository</wa-option>`;
    }
    return html`
      ${repeat(
        this.commitOptions,
        (commit) => commit,
        (commit) => {
          const [hash] = commit.split(': ');
          return html` <wa-option value=${hash}> ${commit} </wa-option> `;
        },
      )}
    `;
  }

  override render(): TemplateResult {
    return html`
      <wa-details
        class="latexdiffs-details"
        ?open=${this.visible}
        @wa-show=${(event: Event) => this.handleDetailsOpenChange(event, true)}
        @wa-hide=${(event: Event) => this.handleDetailsOpenChange(event, false)}
      >
        <span slot="summary" class="latexdiffs-summary">
          ${waIcon('code-branch')} LaTeXDiffs
        </span>
        <div id="latexdiffsContent">
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="baseFile">Base</label>
              </div>
              <div class="file-select-actions">
                ${renderIconActionButton({
                  id: 'currentBaseFileButton',
                  icon: 'file-code',
                  label: 'Set current file as base',
                  tooltip: 'Set current file as base',
                  onClick: () =>
                    this.dispatchEvent(
                      MainViewEvents.getCurrentFile({ type: 'base' }),
                    ),
                })}
                ${renderIconActionButton({
                  id: 'emptyBaseFileButton',
                  icon: 'xmark',
                  label: 'Clear base file',
                  tooltip: 'Clear base file',
                  onClick: () =>
                    this.dispatchEvent(
                      MainViewEvents.emptyFile({ type: 'base' }),
                    ),
                })}
              </div>
            </div>
            <wa-select
              id="baseFile"
              placement="top"
              .value=${this.baseFile}
              @change=${this.handleBaseSelectChange}
            >
              ${this.renderFileOptions(this.baseFileOptions)}
            </wa-select>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label id="editedFileLabel" for="editedFile">Edited</label>
                <wa-tooltip for="editedFileLabel">
                  File containing edits to merge into the base file
                </wa-tooltip>
              </div>
              <div class="file-select-actions">
                ${renderIconActionButton({
                  id: 'refreshEditedFileButton',
                  icon: 'pencil',
                  label: 'Refresh edited files',
                  tooltip: 'Refresh edited files',
                  onClick: this.handleRefreshEditedFiles,
                })}
                ${renderIconActionButton({
                  id: 'currentEditedFileButton',
                  icon: 'file-code',
                  label: 'Set current file as edited',
                  tooltip: 'Set current file as edited',
                  onClick: () =>
                    this.dispatchEvent(
                      MainViewEvents.getCurrentFile({ type: 'edited' }),
                    ),
                })}
                ${renderIconActionButton({
                  id: 'emptyEditedFileButton',
                  icon: 'xmark',
                  label: 'Clear edited file',
                  tooltip: 'Clear edited file',
                  onClick: () =>
                    this.dispatchEvent(
                      MainViewEvents.emptyFile({ type: 'edited' }),
                    ),
                })}
              </div>
            </div>
            <wa-select
              id="editedFile"
              placement="top"
              .value=${this.editedFile}
              @change=${this.handleEditedSelectChange}
            >
              ${this.renderFileOptions(this.editedFileOptions)}
            </wa-select>
            <div class="diff-actions">
              ${this.renderDiffActionGroup(
                'Review changes',
                EDITED_REVIEW_ACTIONS,
              )}
              ${this.renderDiffActionGroup(
                'Apply changes',
                EDITED_APPLY_ACTIONS,
              )}
            </div>
          </div>
          <div class="file-select">
            <div class="file-select-header">
              <div class="file-select-label-group">
                <label for="commit">Commit</label>
              </div>
              <div class="file-select-actions">
                ${renderIconActionButton({
                  id: 'refreshCommitsButton',
                  icon: 'circle-dot',
                  label: 'Refresh commit list',
                  tooltip: 'Refresh commit list',
                  onClick: this.handleRefreshCommits,
                })}
              </div>
            </div>
            <wa-select
              id="commit"
              placement="top"
              .value=${this.commit}
              ?disabled=${!this.isGitRepo}
              @change=${this.handleCommitSelectChange}
            >
              ${this.renderCommitOptions()}
            </wa-select>
            <div class="diff-actions">
              ${this.renderDiffActionGroup(
                'Diff against commit',
                COMMIT_DIFF_ACTIONS,
              )}
              ${this.renderDiffActionGroup(
                'Manage diff output',
                COMMIT_MANAGE_ACTIONS,
              )}
            </div>
          </div>
        </div>
      </wa-details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'latexdiffs-section': LatexDiffsSection;
  }
}
