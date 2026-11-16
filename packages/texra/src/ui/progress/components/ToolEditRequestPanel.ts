/** Tool edit request card: "Edit `paper.tex`", its diff meta, Open diff. */

// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Side-effect imports - register WA components used by this template
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';

// Local imports - shared styles
import { isLatexFile } from '@texra/shared/latexFileTypes';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { buildLineChangeStats } from '@ui/progress/formatters/htmlBuilders';

// Local imports - shared helpers
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { actionMenu } from '@ui/wa/actionMenu';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { lineChangeStatsStyles } from '@ui/styles/surfaceStyles';
import type { RuntimeCommand } from '@texra-ai/harness/schemas';

@customElement('tool-edit-request-panel')
export class ToolEditRequestPanel extends BaseRequestPanel<'toolEdit'> {
  static override styles = [BaseRequestPanel.styles, lineChangeStatsStyles];

  protected override renderAsk(): TemplateResult {
    const { relativePath, path } = this.permission.data;
    return html`Edit <code dir="ltr">${relativePath || path}</code>`;
  }

  /**
   * A windowed host applies the proposed file as the user left it in its
   * diff view, so this panel's approve is the host's `toolEdit` verb: the
   * tool-edit controller reads the edited content back and sends the
   * `request.decide` itself, with the approval's session `grant`. A reject
   * stays the runtime request it is; a host without a diff view (the TUI)
   * decides from the payload alone and never reaches this override.
   */
  protected override sendRuntimeDecision(runtime: RuntimeCommand): void {
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
    super.sendRuntimeDecision(runtime);
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

    const menu = actionMenu([
      {
        label: 'Proposed version',
        activate: () => this.emitAction({ action: 'previewProposed' }),
      },
      {
        label: 'With changes marked (LaTeXdiff)',
        activate: () => this.emitAction({ action: 'showLatexdiff' }),
      },
    ]);
    return html`
      ${openDiff}
      <wa-dropdown
        class="diff-dropdown-menu"
        placement="bottom-start"
        @wa-select=${menu.onSelect}
      >
        ${renderLabeledActionButton({
          icon: 'file-pdf',
          text: 'Preview PDF',
          slot: 'trigger',
          action: 'previewMenu',
          caret: true,
        })}
        ${menu.items}
      </wa-dropdown>
    `;
  }

  private renderDiffMeta(): TemplateResult {
    // `NonNegativeIntSchema` makes both counts required nonnegative integers.
    const { addedLines: added, removedLines: removed } = this.permission.data;
    return buildLineChangeStats({ added, removed });
  }

  // ===========================================================================
  // Diff menu handlers
  // ===========================================================================

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
