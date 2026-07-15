/** Tool edit approval request panel. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type { ToolEditPermission } from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderDotMeta, type MetaPart } from '@shared/wa/metaStrip';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { pluralize } from '@utils/text/stringUtils';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

// Local imports - helpers
import { monacoLanguageForPath } from './monacoLanguage';

// Local imports - styles
import { toolEditRequestPanelStyles } from './ToolEditRequestPanel.styles';

@customElement('tool-edit-request-panel')
export class ToolEditRequestPanel extends BaseFeedbackPanel<'toolEdit'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    requestPanelSharedStyles,
    toolEditRequestPanelStyles,
  ];

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
      <div class="diff-dropdown">
        ${renderLabeledActionButton({
          icon: 'diff',
          text: diffLabel,
          title: diffTitle,
          className: 'diff-main-button',
          onClick: this.handleDiffAction,
        })}
        ${
          showDropdown
            ? html`
                <wa-dropdown
                  class="diff-dropdown-menu"
                  placement="bottom-end"
                  @wa-select=${this.handleMenuSelect}
                >
                  <wa-button
                    id="tool-edit-diff-dropdown-trigger"
                    slot="trigger"
                    class="diff-dropdown-trigger"
                    appearance="plain"
                    variant="neutral"
                    size="small"
                    type="button"
                    aria-label="More diff actions"
                  >
                    ${waIcon('chevron-down')}
                  </wa-button>
                  <wa-dropdown-item value="previewProposed">
                    Preview
                  </wa-dropdown-item>
                  <wa-dropdown-item value="showLatexdiff">
                    LaTeXdiff
                  </wa-dropdown-item>
                </wa-dropdown>
                <wa-tooltip for="tool-edit-diff-dropdown-trigger">
                  More diff actions
                </wa-tooltip>
              `
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
      <span class="approval-request__diff" title=${tooltip}>
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
    `;
  }

  // ===========================================================================
  // Diff menu handlers
  // ===========================================================================

  private handleMenuSelect = (
    event: CustomEvent<{ item: HTMLElement }>,
  ): void => {
    const action =
      (event.detail?.item as HTMLElement & { value?: string })?.value ?? '';
    if (!action) return;
    this.emitAction(action);
  };

  private handleDiffAction = (): void => {
    const data = this.permission.data;
    if (this.hasInlineDiff(data)) {
      this.inlineDiffOpen = !this.inlineDiffOpen;
      return;
    }
    this.emitAction('openDiff');
  };

  private hasInlineDiff(data: ToolEditPermission): boolean {
    return data.originalContent != null || data.proposedContent != null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-edit-request-panel': ToolEditRequestPanel;
  }
}
