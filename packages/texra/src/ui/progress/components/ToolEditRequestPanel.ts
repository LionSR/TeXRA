/** Tool edit request card: "Edit `paper.tex`", its diff meta, Open diff. */

// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components used by this template
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import { isLatexFile } from '@texra/shared/latexFileTypes';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { describeLineChanges } from '@ui/copy/format';

// Local imports - shared helpers
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { selectedItemValue } from '@ui/wa/selectTemplates';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { toolEditRequestPanelStyles } from './ToolEditRequestPanel.styles';
import type { RuntimeCommand } from '@texra-ai/harness/schemas';
import { pluralize } from '@texra-ai/harness/schemas';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

@customElement('tool-edit-request-panel')
export class ToolEditRequestPanel extends BaseRequestPanel<'toolEdit'> {
  static override styles = [
    BaseRequestPanel.styles,
    toolEditRequestPanelStyles,
  ];

  protected override renderAsk(): TemplateResult {
    const { relativePath, path } = this.permission.data;
    return html`Edit <code dir="ltr">${relativePath || path}</code>`;
  }

  /**
   * A windowed host applies the proposed file as the user left it in its
   * diff view, so this panel's approve is the host's `toolEdit` verb: the
   * tool-edit controller reads the edited content back and sends the
   * `request.decide` itself, with the approval's session `grant`. A reject
   * stays the runtime arm it is; a host without a diff view (the TUI)
   * decides from the payload alone and never reaches this override.
   */
  protected override emitRuntimeArm(runtime: RuntimeCommand): void {
    if (
      runtime.kind === 'request.decide' &&
      runtime.decision.action === 'approve'
    ) {
      this.dispatchEvent(
        SessionUiEvents.host({
          kind: 'toolEdit',
          requestId: runtime.requestId,
          action: 'approve',
          grant: runtime.grant,
        }),
      );
      return;
    }
    super.emitRuntimeArm(runtime);
  }

  protected override handleExtraKey(key: string): boolean {
    if (key === 'd') {
      this.handleDiffAction();
      return true;
    }
    return false;
  }

  override render(): TemplateResult {
    return this.renderCard(
      html`<div class="request-card__meta">${this.renderDiffMeta()}</div>`,
      this.renderDiffActions(),
    );
  }

  // ===========================================================================
  // Diff-specific rendering
  // ===========================================================================

  /**
   * Open diff, and for a LaTeX file a labeled "Preview PDF" menu: the
   * proposed version compiled, or a LaTeXdiff with the changes marked.
   */
  private renderDiffActions(): TemplateResult {
    const openDiff = renderLabeledActionButton({
      id: 'tool-edit-diff-button',
      icon: 'code-compare',
      text: 'Open diff',
      tooltip: 'Open diff (d)',
      action: 'openDiff',
      disabled: this.readOnly,
      onClick: this.handleDiffAction,
    });
    if (!isLatexFile(this.permission.data.path) || this.readOnly)
      return openDiff;

    return html`
      ${openDiff}
      <wa-dropdown
        class="diff-dropdown-menu"
        placement="bottom-start"
        @wa-select=${this.handleMenuSelect}
      >
        <wa-button
          slot="trigger"
          class="action-button"
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          with-caret
          data-action="previewMenu"
          >${waIcon('file-pdf', { slot: 'start' })}Preview PDF</wa-button
        >
        <wa-dropdown-item value="previewProposed"
          >Proposed version</wa-dropdown-item
        >
        <wa-dropdown-item value="showLatexdiff"
          >With changes marked (LaTeXdiff)</wa-dropdown-item
        >
      </wa-dropdown>
    `;
  }

  private renderDiffMeta(): TemplateResult {
    // `NonNegativeIntSchema` makes both counts required nonnegative integers.
    const { addedLines: added, removedLines: removed } = this.permission.data;
    const total = added + removed;
    const lineLabel = pluralize(total, 'line');

    return html`
      <span id="tool-edit-diff-summary" class="tool-edit__diff">
        ${when(
          added > 0,
          () => html`<span class="tool-edit__diff-added">+${added}</span>`,
        )}
        ${when(
          removed > 0,
          () => html`<span class="tool-edit__diff-removed">-${removed}</span>`,
        )}
        <span class="tool-edit__diff-label">${total} ${lineLabel}</span>
      </span>
      <wa-tooltip for="tool-edit-diff-summary"
        >${describeLineChanges({ added, removed })}</wa-tooltip
      >
    `;
  }

  // ===========================================================================
  // Diff menu handlers
  // ===========================================================================

  private handleMenuSelect = (event: WaSelectEvent): void => {
    const action = selectedItemValue(event);
    switch (action) {
      case 'showLatexdiff':
      case 'previewProposed':
        this.emitAction({ action });
        break;
    }
  };

  // Every host answers `openDiff` with its own diff surface: the extension
  // opens a VS Code diff tab (VscodeDiffViewHost), the desktop posts
  // `desktop:showDiff` to its Review workbench (desktopDiffHost).
  private handleDiffAction = (): void => {
    this.emitAction({ action: 'openDiff' });
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-edit-request-panel': ToolEditRequestPanel;
  }
}
