/** Tool edit approval request panel. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components used by this template
// (the split-button caret/menu registrations come from @shared/wa/splitButton)
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
import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderDotMeta, type MetaPart } from '@shared/wa/metaStrip';
import { renderSplitButtonMenu } from '@shared/wa/splitButton';
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

  @state() private inlineDiffOpen = false;

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
      trailing: this.renderInlineDiff(data),
    });
  }

  // ===========================================================================
  // Diff-specific rendering
  // ===========================================================================

  private renderDiffActions(): TemplateResult {
    const data = this.permission.data;
    const showDropdown = Boolean(data.isLatex);
    const hasInlineDiff = this.hasInlineDiff(data);

    const diffLabel =
      hasInlineDiff && this.inlineDiffOpen ? 'Hide diff' : 'Open diff';
    let diffTitle: string;
    if (!hasInlineDiff) {
      diffTitle = 'Open diff (d)';
    } else if (this.inlineDiffOpen) {
      diffTitle = 'Hide inline diff (d)';
    } else {
      diffTitle = 'Open inline diff (d)';
    }

    return html`
      <div class="diff-dropdown split-button">
        ${renderLabeledActionButton({
          id: 'tool-edit-diff-button',
          icon: 'code-compare',
          text: diffLabel,
          tooltip: diffTitle,
          className: 'diff-main-button split-button-main',
          onClick: this.handleDiffAction,
        })}
        ${
          showDropdown
            ? renderSplitButtonMenu({
                classPrefix: 'diff-dropdown',
                triggerId: 'tool-edit-diff-dropdown-trigger',
                triggerAriaLabel: 'More diff actions',
                tooltip: 'More diff actions',
                items: html`
                  <wa-dropdown-item value="previewProposed">
                    Preview
                  </wa-dropdown-item>
                  <wa-dropdown-item value="showLatexdiff">
                    LaTeXdiff
                  </wa-dropdown-item>
                `,
                onSelect: this.handleMenuSelect,
              })
            : nothing
        }
      </div>
    `;
  }

  private renderInlineDiff(
    data: ToolEditPermission,
  ): TemplateResult | typeof nothing {
    if (!this.inlineDiffOpen || !this.hasInlineDiff(data)) {
      return nothing;
    }

    return html`
      <texra-diff-view
        class="approval-request__inline-diff"
        .originalText=${data.originalContent ?? ''}
        .proposedText=${data.proposedContent ?? ''}
        .language=${monacoLanguageForPath(data.path)}
      ></texra-diff-view>
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

  private handleDiffAction = (): void => {
    const data = this.permission.data;
    if (this.hasInlineDiff(data)) {
      this.inlineDiffOpen = !this.inlineDiffOpen;
      return;
    }
    this.emitAction({ action: 'openDiff' });
  };

  private hasInlineDiff(data: ToolEditPermission): boolean {
    // Only the desktop registers <texra-diff-view>; the extension and trace
    // viewer ship no Monaco and fall through to openDiff (VS Code's own diff).
    // Read per call, not at module scope: the desktop imports the progressView
    // barrel — and so this module — one line before it registers the element.
    if (customElements.get('texra-diff-view') === undefined) return false;
    return data.originalContent != null || data.proposedContent != null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-edit-request-panel': ToolEditRequestPanel;
  }
}
