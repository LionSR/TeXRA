/**
 * `<chat-tool-block kind="call|result|web-search|web-fetch" name?>`
 *
 * Used for tool calls, tool results, web-search queries, and web-fetch
 * snapshots. The role label and (for tool calls) the tool name chip live
 * in shadow DOM; the body is light-DOM via slot.
 */
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { bubbleFrame, chatTokens } from '../styles/tokens';

export type ToolBlockKind = 'call' | 'result' | 'web-search' | 'web-fetch';

const ROLE_LABELS: Record<ToolBlockKind, string> = {
  call: 'Tool call',
  result: 'Tool result',
  'web-search': 'Web search',
  'web-fetch': 'Web fetch',
};

@customElement('chat-tool-block')
export class ChatToolBlock extends LitElement {
  static override styles = [
    chatTokens,
    bubbleFrame,
    css`
      :host {
        --ce-tool-bg: var(--ce-bg-tool);
      }
      .frame {
        background: var(--ce-tool-bg);
      }
      .role {
        color: var(--ce-fg-tool-label);
      }
      .tool-name {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 4px 20px 0;
        font-family: var(--ce-font-mono);
        font-size: 13px;
      }
      .tool-name code {
        background: var(--ce-bg-elevated);
        padding: 2px 8px;
        border-radius: 4px;
        border: 1px solid var(--ce-border);
        font-weight: 600;
      }
    `,
  ];

  @property({ reflect: true }) kind: ToolBlockKind = 'call';
  @property() name: string | null = null;

  override render() {
    const label = ROLE_LABELS[this.kind] ?? 'Tool';
    return html`
      <div class="frame">
        <div class="role">${label}</div>
        ${this.name
          ? html`<div class="tool-name">tool <code>${this.name}</code></div>`
          : nothing}
        <div class="body"><slot></slot></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-tool-block': ChatToolBlock;
  }
}
