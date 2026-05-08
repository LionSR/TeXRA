/**
 * Individual panel component for tool edit approval requests.
 *
 * Renders a single tool edit permission with diff metadata, diff actions
 * (including LaTeX dropdown), approve/reject buttons, and feedback input.
 *
 * Extends BaseFeedbackPanel for shared feedback/reject/emit logic.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type { ToolEditPermission } from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

// Local imports - helpers
import { monacoLanguageForPath } from './monacoLanguage';

@customElement('tool-edit-request-panel')
export class ToolEditRequestPanel extends BaseFeedbackPanel {
  static override styles = [designTokens, commonViewStyles, requestPanelStyles];

  @state() private diffMenuOpen = false;
  @state() private inlineDiffOpen = false;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.handleOutsideClick, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('click', this.handleOutsideClick, true);
    super.disconnectedCallback();
  }

  protected override handleExtraKey(key: string): boolean {
    if (key === 'd') {
      this.handleDiffAction();
      return true;
    }
    return false;
  }

  override render(): TemplateResult {
    const data = this.permission.data as ToolEditPermission;
    const diffMeta = this.renderDiffMeta(data);

    return html`
      <div
        class=${classMap({
          'approval-request': true,
          'approval-request--feedback-active': this.showFeedback,
        })}
      >
        <div class="approval-request__details">
          <div class="approval-request__path">
            ${data.relativePath || data.path}
          </div>
          <div class="approval-request__meta">
            ${data.sourceTool ? `Requested by ${data.sourceTool}` : ''}
            ${data.sourceTool && diffMeta ? html`<span>•</span>` : nothing}
            ${diffMeta}
          </div>
        </div>
        <div class="approval-request__actions">
          ${this.renderDiffActions()}
          ${renderLabeledActionButton({
            icon: 'check',
            text: 'Approve',
            title: 'Approve (y)',
            action: 'approve',
            onClick: () => this.emitAction('approve'),
          })}
          ${this.renderRejectButton('Reject (n)')}
        </div>
        ${this.renderFeedbackSection(
          'approval-request__feedback',
          'approval-request__feedback-input',
        )}
        ${this.renderInlineDiff(data)}
      </div>
    `;
  }

  // ===========================================================================
  // Diff-specific rendering
  // ===========================================================================

  private renderDiffActions(): TemplateResult {
    const data = this.permission.data as ToolEditPermission;
    const showDropdown = Boolean(data.isLatex);
    const hasInlineDiff = this.hasInlineDiff(data);

    const diffLabel =
      hasInlineDiff && this.inlineDiffOpen ? 'Hide diff' : 'Open diff';
    const diffTitle = hasInlineDiff
      ? this.inlineDiffOpen
        ? 'Hide inline diff (d)'
        : 'Open inline diff (d)'
      : 'Open diff (d)';

    return html`
      <div class="diff-dropdown">
        ${renderLabeledActionButton({
          icon: 'diff',
          text: diffLabel,
          title: diffTitle,
          className: 'diff-main-button',
          onClick: this.handleDiffAction,
        })}
        ${showDropdown
          ? html`
              <wa-button
                class="action-icon-button diff-dropdown-trigger"
                appearance="plain"
                variant="neutral"
                size="small"
                type="button"
                aria-haspopup="true"
                aria-expanded=${this.diffMenuOpen ? 'true' : 'false'}
                aria-label="More diff actions"
                title="More diff actions"
                @click=${this.toggleDiffMenu}
              >
                ${waIcon('chevron-down')}
              </wa-button>
              <vscode-context-menu
                class="diff-dropdown-menu"
                ?show=${this.diffMenuOpen}
                .data=${[
                  { label: 'Preview', value: 'previewProposed' },
                  { label: 'LaTeXdiff', value: 'showLatexdiff' },
                ]}
                @vsc-click=${this.handleMenuClick}
              ></vscode-context-menu>
            `
          : nothing}
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
    const lineLabel = total === 1 ? 'line' : 'lines';

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

  private handleMenuClick = (event: CustomEvent): void => {
    const action = event.detail?.value ?? '';
    if (!action) return;
    this.diffMenuOpen = false;
    this.emitAction(action);
  };

  private handleOutsideClick = (event: MouseEvent): void => {
    if (!this.diffMenuOpen) return;

    const path = event.composedPath?.() ?? [];
    const clickedInside = path.some(
      (node) =>
        node instanceof Element &&
        (node.classList.contains('diff-dropdown') ||
          node.classList.contains('diff-dropdown-menu')),
    );
    if (!clickedInside) {
      this.diffMenuOpen = false;
    }
  };

  private toggleDiffMenu = (event: MouseEvent): void => {
    event.stopPropagation();
    this.diffMenuOpen = !this.diffMenuOpen;
  };

  private handleDiffAction = (): void => {
    const data = this.permission.data as ToolEditPermission;
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
