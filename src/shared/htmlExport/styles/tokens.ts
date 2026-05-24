/**
 * Design tokens shared between the chat-export Lit components.
 *
 * The tokens are defined as CSS custom properties on `:host`, with a
 * `@media (prefers-color-scheme: dark)` block that re-binds them. Each
 * component composes `chatTokens` first in its `static styles` array, so
 * the component-local rules can read `var(--ce-fg)` etc. without caring
 * whether the page is light or dark.
 *
 * Tokens are deliberately a small, neutral set — this is a static page
 * shared with people who don't have the user's VS Code theme. The token
 * values are tuned to look like GitHub's content theme (familiar to most
 * readers, accessible contrast).
 */
import { css } from 'lit';

export const chatTokens = css`
  :host {
    --ce-bg: #ffffff;
    --ce-bg-elevated: #f6f8fa;
    --ce-bg-user: #eef4ff;
    --ce-bg-assistant: #ffffff;
    --ce-bg-tool: #fff8e6;
    --ce-fg: #1f2328;
    --ce-fg-muted: #59636e;
    --ce-fg-tool-label: #9a6700;
    --ce-border: #d0d7de;
    --ce-border-strong: #afb8c1;
    --ce-accent: #0969da;
    --ce-accent-soft: #ddf4ff;
    --ce-code-bg: #f6f8fa;
    --ce-shadow: 0 1px 0 rgba(31, 35, 40, 0.04);
    --ce-radius: 8px;
    --ce-font-sans:
      -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial,
      sans-serif;
    --ce-font-mono:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
      monospace;
  }

  @media (prefers-color-scheme: dark) {
    :host {
      --ce-bg: #0d1117;
      --ce-bg-elevated: #161b22;
      --ce-bg-user: #1c2a3a;
      --ce-bg-assistant: #161b22;
      --ce-bg-tool: #2a2415;
      --ce-fg: #e6edf3;
      --ce-fg-muted: #8d96a0;
      --ce-fg-tool-label: #d4a72c;
      --ce-border: #30363d;
      --ce-border-strong: #484f58;
      --ce-accent: #2f81f7;
      --ce-accent-soft: #0c2d6b;
      --ce-code-bg: #161b22;
      --ce-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
    }
  }
`;

/** Shared styles applied inside every message bubble's shadow root. */
export const bubbleFrame = css`
  :host {
    display: block;
    margin-bottom: 16px;
  }

  .frame {
    border: 1px solid var(--ce-border);
    border-radius: var(--ce-radius);
    box-shadow: var(--ce-shadow);
    overflow: hidden;
  }

  .role {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--ce-fg-muted);
    padding: 12px 20px 0;
  }

  .body {
    padding: 8px 20px 16px;
  }
`;
