import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { formatWordList } from '@texra-ai/worldline/schemas';
import type { MissingTool } from '@texra/shared/session/hostSnapshot';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { bannerStyles } from '@ui/styles';
import { focusRingStyles } from '@ui/styles/controlStyles';
import { TexraElement } from '@ui/litBase';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { renderWarningBanner } from '@ui/wa/bannerFrame';

/**
 * The missing-tools warning: one sentence naming what is missing and what
 * TeXRA can't do without it, then Install guide, Check again, and ×.
 * Interchangeable tools (GraphicsMagick, ImageMagick) read as one "or".
 */
@customElement('dependency-banner')
export class DependencyBanner extends TexraElement {
  static override styles = [
    TexraElement.styles,
    bannerStyles,
    focusRingStyles,
    css`
      .message {
        flex: 1 1 100%;
      }
    `,
  ];

  @property({ attribute: false }) missingTools: readonly MissingTool[] = [];

  private install(): void {
    this.dispatchEvent(SessionUiEvents.host({ kind: 'openInstallGuide' }));
  }

  override render(): TemplateResult {
    const tools = this.missingTools;
    const either = tools.filter((tool) => tool.interchangeable);
    // The names to list: each required tool, and the interchangeable ones as one.
    const groups = [
      ...tools
        .filter((tool) => !tool.interchangeable)
        .map((tool) => tool.label),
      ...(either.length > 0
        ? [
            formatWordList(
              either.map((tool) => tool.label),
              'or',
            ),
          ]
        : []),
    ];
    const uses = [...new Set(tools.map((tool) => tool.usedFor))];
    const single = groups.length === 1 ? groups[0] : undefined;
    // One tool: its name is plain text and Install guide opens the guide.
    // Several: each name is its own install-guide link, joined as
    // `formatWordList` joins words ("a and b", "a, b, and c").
    const last = groups.length - 1;
    const joiner = (index: number): string => {
      if (index === 0) return '';
      if (index < last) return ', ';
      return last === 1 ? ' and ' : ', and ';
    };
    const names = single
      ? html`<bdi dir="auto">${single}</bdi>`
      : groups.map(
          (group, index) =>
            html`${joiner(index)}<button
                type="button"
                class="clickable-link focus-ring"
                aria-label=${`Open the ${group} install guide`}
                @click=${() => this.install()}
              >
                <bdi dir="auto">${group}</bdi>
              </button>`,
        );
    return renderWarningBanner({
      id: 'dependencyBanner',
      role: 'status',
      body: html`
        <span class="message"
          >${names} ${single ? "isn't" : "aren't"} installed, so TeXRA can't
          ${formatWordList(uses, 'or')}.</span
        >
        <div class="actions">
          ${
            single
              ? renderLabeledActionButton({
                  icon: 'book',
                  text: 'Install guide',
                  onClick: () => this.install(),
                })
              : nothing
          }
          ${renderLabeledActionButton({
            id: 'dependencyRecheckButton',
            icon: 'arrows-rotate',
            text: 'Check again',
            onClick: () =>
              this.dispatchEvent(
                SessionUiEvents.host({ kind: 'recheckDependencies' }),
              ),
          })}
          ${renderIconActionButton({
            id: 'dependencyDismissButton',
            icon: 'xmark',
            label: 'Hide for now',
            tooltip: 'Hide for now',
            onClick: () =>
              this.dispatchEvent(
                SessionUiEvents.host({
                  kind: 'dismissBanner',
                  banner: 'dependency',
                }),
              ),
          })}
        </div>
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dependency-banner': DependencyBanner;
  }
}
