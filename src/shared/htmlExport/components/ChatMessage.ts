/**
 * `<texra-chat-message data-role="user|assistant">` — basic conversation bubble.
 *
 * Pure presentation: no signals, no event listeners, no VS Code theme
 * variables. Body content is light-DOM (slotted) so KaTeX / hljs CSS in
 * the host document reaches it normally; the bubble frame lives inside
 * shadow DOM so it can be styled in isolation.
 *
 * `data-role` (not `role`) — `role` is a reserved ARIA attribute whose
 * valid values don't include "user"/"assistant"; using it would trip
 * accessibility audits on every bubble in a shared export.
 *
 * The `texra-` prefix on the custom-element tag is namespace insurance:
 * this module lives under `src/shared/` so a webview could one day
 * accidentally import it, and `customElements.define()` throws on
 * duplicate registration. A specific prefix makes that collision
 * astronomically unlikely.
 */
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { bubbleFrame, chatTokens } from '../styles/tokens';

export type ChatRole = 'user' | 'assistant';

@customElement('texra-chat-message')
export class ChatMessage extends LitElement {
  static override styles = [
    chatTokens,
    bubbleFrame,
    css`
      :host([data-role='user']) .frame {
        background: var(--ce-bg-user);
      }
      :host([data-role='assistant']) .frame {
        background: var(--ce-bg-assistant);
      }
    `,
  ];

  @property({ reflect: true, attribute: 'data-role' })
  role: ChatRole = 'user';

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
    'texra-chat-message': ChatMessage;
  }
}
