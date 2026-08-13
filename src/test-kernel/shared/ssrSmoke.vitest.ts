import { describe, expect, it } from 'vitest';
import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { render } from '@lit-labs/ssr';
import { collectResultSync } from '@lit-labs/ssr/lib/render-result.js';

class SmokeBubble extends LitElement {
  static override properties = {
    role: {},
  };

  static override styles = css`
    :host {
      display: block;
    }
    .frame {
      border-radius: 8px;
      padding: 12px;
    }
  `;

  role = 'user';

  override render() {
    return html`
      <div class="frame">
        <div class="role">${this.role}</div>
        <slot></slot>
      </div>
    `;
  }
}

customElement('smoke-bubble')(SmokeBubble);

describe('@lit-labs/ssr smoke', () => {
  it('renders a custom element to declarative shadow DOM in Node', () => {
    const out = collectResultSync(
      render(html`<smoke-bubble role="assistant">hello</smoke-bubble>`),
    );
    expect(out).toContain('<smoke-bubble');
    // SSR emits both `shadowroot` (legacy) and `shadowrootmode` (current)
    // attributes on the declarative shadow root template.
    expect(out).toMatch(/<template[^>]*shadowrootmode="open"/);
    expect(out).toContain('<style>');
    expect(out).toContain('border-radius: 8px');
    expect(out).toContain('hello');
  });
});
