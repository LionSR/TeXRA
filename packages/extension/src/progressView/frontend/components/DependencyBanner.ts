import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, css, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens, commonViewStyles, bannerStyles } from '@ui/styles';
import { focusRingStyles } from '@ui/styles/controlStyles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { renderWarningBanner } from '@ui/wa/bannerFrame';

/** What TeXRA can't do: "a", "a or b", "a, b or c". */
function eitherOf(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/**
 * The missing-tools warning: one sentence naming what is missing and what
 * TeXRA can't do without it, then Install guide, Check again, and ×.
 * Interchangeable tools (GraphicsMagick, ImageMagick) read as one "or".
 */
@customElement('dependency-banner')
export class DependencyBanner extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    focusRingStyles,
    css`
      .message {
        flex: 1 1 100%;
      }
      /* An inline link-styled button: a wa-button would break the sentence. */
      .tool-link {
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
      }
    `,
  ];

  @property({ attribute: false }) state: HostSnapshot['banners']['dependency'] =
    {
      visible: false,
    };

  private install(tool: string): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'openInstallGuide', tool }),
    );
  }

  override render(): TemplateResult {
    const tools = this.state.missingTools ?? [];
    const either = tools.filter((tool) => tool.interchangeable);
    const [firstEither] = either;
    const groups = [
      ...tools
        .filter((tool) => !tool.interchangeable)
        .map((tool) => ({ id: tool.id, name: tool.label })),
      ...(firstEither
        ? [
            {
              id: firstEither.id,
              name: either.map((tool) => tool.label).join(' or '),
            },
          ]
        : []),
    ];
    const uses = [...new Set(tools.map((tool) => tool.usedFor))];
    const single = groups.length === 1 ? groups[0] : undefined;
    // One tool: its name is plain text and Install guide opens its page.
    // Several: each name is its own install-guide link, joined "a, b and c".
    const last = groups.length - 1;
    const joiner = (index: number): string => {
      if (index === 0) return '';
      return index === last ? ' and ' : ', ';
    };
    const names = single
      ? html`<bdi dir="auto">${single.name}</bdi>`
      : groups.map(
          (group, index) =>
            html`${joiner(index)}<button
                type="button"
                class="tool-link focus-ring"
                aria-label=${`Open the ${group.name} install guide`}
                @click=${() => this.install(group.id)}
              >
                <bdi dir="auto">${group.name}</bdi>
              </button>`,
        );
    return renderWarningBanner({
      id: 'dependencyBanner',
      role: 'status',
      body: html`
        <span class="message"
          >${names} ${single ? "isn't" : "aren't"} installed, so TeXRA can't
          ${eitherOf(uses)}.</span
        >
        <div class="actions">
          ${
            single
              ? html`<wa-button
                  appearance="plain"
                  size="s"
                  @click=${() => this.install(single.id)}
                  >${waIcon('book', { slot: 'start' })}Install guide</wa-button
                >`
              : nothing
          }
          <wa-button
            id="dependencyRecheckButton"
            appearance="plain"
            size="s"
            @click=${() =>
              this.dispatchEvent(
                SessionUiEvents.host({ kind: 'recheckDependencies' }),
              )}
            >${waIcon('rotate-right', { slot: 'start' })}Check again</wa-button
          >
          ${renderIconActionButton({
            id: 'dependencyDismissButton',
            icon: 'xmark',
            label: 'Dismiss for this session',
            tooltip: 'Dismiss for this session',
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
