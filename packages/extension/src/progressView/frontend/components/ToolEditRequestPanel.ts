/** Tool edit approval request panel. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components used by this template
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type { ToolEditPermission } from '@shared/schemas';
import {
  renderLabeledActionButton,
  renderLabeledActionButtonParts,
} from '@shared/wa/actionButtons';
import { renderDotMeta, type MetaPart } from '@shared/wa/metaStrip';
import { renderSplitButtonMenuParts } from '@shared/wa/splitButton';
import { pluralize } from '@utils/text/stringUtils';

// Local imports - base class
import { BaseBypassApprovalPanel } from './BaseBypassApprovalPanel';

// Local imports - styles
import { toolEditRequestPanelStyles } from './ToolEditRequestPanel.styles';

@customElement('tool-edit-request-panel')
export class ToolEditRequestPanel extends BaseBypassApprovalPanel<'toolEdit'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    requestPanelSharedStyles,
    toolEditRequestPanelStyles,
  ];

  protected readonly approvalDecision = { action: 'approve' } as const;

  protected override handleExtraKey(key: string): boolean {
    if (key === 'd') {
      this.handleDiffAction();
      return true;
    }
    return false;
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const diffMeta = this.renderDiffMeta(data);
    const metaParts: MetaPart[] = [];
    if (data.sourceTool) metaParts.push(`Requested by ${data.sourceTool}`);
    if (diffMeta !== nothing) metaParts.push(diffMeta);

    return this.renderRequestShell({
      prefix: 'approval-request',
      details: html`
        <div class="approval-request__path">
          ${data.relativePath || data.path}
        </div>
        <div class="approval-request__meta">${renderDotMeta(metaParts)}</div>
      `,
      approveTitle: 'Approve (y)',
      rejectTitle: 'Reject (n)',
      leadingActions: this.renderDiffActions(),
    });
  }

  // ===========================================================================
  // Diff-specific rendering
  // ===========================================================================

  private renderDiffActions(): TemplateResult {
    const hasMenu = Boolean(this.permission.data.isLatex && !this.archived);
    const buttonOptions = {
      id: 'tool-edit-diff-button',
      icon: 'code-compare' as const,
      text: 'Open diff',
      tooltip: 'Open diff (d)',
      action: 'openDiff',
      className: 'diff-main-button',
      disabled: this.archived,
      onClick: this.handleDiffAction,
    };

    if (!hasMenu) return renderLabeledActionButton(buttonOptions);

    const diffButton = renderLabeledActionButtonParts({
      ...buttonOptions,
      nativeChrome: true,
    });
    const diffMenu = renderSplitButtonMenuParts({
      classPrefix: 'diff-dropdown',
      triggerId: 'tool-edit-diff-dropdown-trigger',
      triggerAriaLabel: 'More diff actions',
      tooltip: 'More diff actions',
      items: html`
        <wa-dropdown-item value="previewProposed">Preview</wa-dropdown-item>
        <wa-dropdown-item value="showLatexdiff">LaTeXdiff</wa-dropdown-item>
      `,
      onSelect: this.handleMenuSelect,
    });

    return html`
      <wa-button-group class="diff-dropdown" label="Diff actions">
        ${diffButton.button} ${diffMenu.menu}
      </wa-button-group>
      ${diffButton.tooltip} ${diffMenu.tooltip}
    `;
  }

  private renderDiffMeta(
    request: ToolEditPermission,
  ): TemplateResult | typeof nothing {
    const toCount = (value: number | undefined): number =>
      value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
    const added = toCount(request.addedLines);
    const removed = toCount(request.removedLines);
    const total = added + removed;
    const lineLabel = pluralize(total, 'line');

    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`-${removed}`);
    const tooltip =
      total === 0
        ? 'No line changes'
        : `${parts.join(' / ')} ${lineLabel} changed`;

    return html`
      <span id="tool-edit-diff-summary" class="approval-request__diff">
        ${when(
          added > 0,
          () =>
            html`<span class="approval-request__diff-added">+${added}</span>`,
        )}
        ${when(
          removed > 0,
          () =>
            html`<span class="approval-request__diff-removed"
              >-${removed}</span
            >`,
        )}
        <span class="approval-request__diff-label">${total} ${lineLabel}</span>
      </span>
      <wa-tooltip for="tool-edit-diff-summary">${tooltip}</wa-tooltip>
    `;
  }

  // ===========================================================================
  // Diff menu handlers
  // ===========================================================================

  private handleMenuSelect = (action: string): void => {
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
