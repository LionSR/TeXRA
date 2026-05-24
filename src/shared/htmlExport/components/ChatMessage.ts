/**
 * `<chat-message role="user|assistant">` — the basic conversation bubble.
 *
 * Pure presentation: no signals, no event listeners, no VS Code theme
 * variables. Body content is light-DOM (slotted) so KaTeX / hljs CSS in
 * the host document reaches it normally; the bubble frame lives inside
 * shadow DOM so it can be styled in isolation.
 */
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { bubbleFrame, chatTokens } from '../styles/tokens';

export type ChatRole = 'user' | 'assistant';

@customElement('chat-message')
export class ChatMessage extends LitElement {
  static override styles = [
    chatTokens,
    bubbleFrame,
    css`
      :host([role='user']) .frame {
        background: var(--ce-bg-user);
      }
      :host([role='assistant']) .frame {
        background: var(--ce-bg-assistant);
      }
    `,
  ];

  @property({ reflect: true }) role: ChatRole = 'user';

  override render() {
    return html`
      <div class="frame">
        <div class="role">${this.role}</div>
        <div class="body"><slot></slot></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-message': ChatMessage;
  }
}
