// Third-party imports
import { css } from 'lit';

/**
 * Code block styles for syntax highlighted code with language badge and copy button.
 * Used by buildCodeBlock() in htmlBuilders.
 */
export const codeBlockStyles = css`
  .code-block {
    position: relative;
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m, var(--border-radius-small));
    overflow: hidden;
    max-width: 100%;
    min-width: 0;
  }

  .code-block-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    background-color: var(--wa-color-surface-lowered);
    border-bottom: var(--border-thin) solid var(--color-border);
    font-size: var(--font-size-xs);
  }

  .code-block-language {
    color: var(--wa-color-text-quiet, #888);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-caps);
    font-weight: var(--font-weight-medium);
  }

  .code-block pre {
    margin: 0;
    padding: var(--wa-space-2xs);
    background-color: var(--wa-color-surface-default);
    border: 0;
    border-radius: 0;
    overflow-x: auto;
    box-sizing: border-box;
    max-width: 100%;
    min-width: 0;
  }

  .code-block pre code {
    display: block;
    min-width: 0;
  }

  .code-block pre.tool-command-input {
    overflow-x: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .code-block pre.tool-command-input code,
  .code-block pre.tool-command-input code * {
    white-space: inherit;
    overflow-wrap: inherit;
    word-break: inherit;
  }

  .code-block-copy::part(base) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border: none;
    background: transparent;
    color: var(--wa-color-text-quiet, #888);
    border-radius: var(--border-radius-small);
  }

  .code-block-copy::part(base):hover {
    color: var(--wa-color-text-normal);
  }

  .code-block-copy.copied::part(base) {
    color: var(--wa-color-git-added, #3fb950);
  }

  /* Kept rather than deleted like the others: the focus-visible rule in
     focusRingStyles cannot reach inside wa-button's shadow root, so this
     part-piercing rule is the only ring this control gets. Widened to the
     shared tokens. */
  .code-block-copy:focus-visible::part(base) {
    outline: var(--focus-ring-width) solid var(--wa-color-focus);
    outline-offset: var(--focus-ring-offset);
  }

  /* Syntax highlighted code blocks */
  pre.hljs code {
    background: transparent;
    padding: 0;
  }

  /* Highlight.js theme - VS Code colors for Shadow DOM */
  pre.hljs,
  .hljs {
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
  }

  .hljs-comment,
  .hljs-quote {
    color: var(--wa-color-text-quiet);
    font-style: italic;
  }

  .hljs-keyword,
  .hljs-selector-tag,
  .hljs-tag {
    color: var(--wa-color-symbol-keyword, var(--wa-color-text-link));
  }

  .hljs-string,
  .hljs-doctag,
  .hljs-regexp,
  .hljs-template-tag,
  .hljs-template-variable {
    color: var(--wa-color-debug-string, #a31515);
  }

  .hljs-number,
  .hljs-literal,
  .hljs-built_in,
  .hljs-type {
    color: var(--wa-color-debug-number, #098658);
  }

  .hljs-variable,
  .hljs-params,
  .hljs-attr {
    color: var(--wa-color-symbol-variable, var(--wa-color-text-normal));
  }

  .hljs-function,
  .hljs-title,
  .hljs-title.function_ {
    color: var(--wa-color-symbol-function, #795e26);
  }

  .hljs-class .hljs-title,
  .hljs-title.class_,
  .hljs-title.class_.inherited__ {
    color: var(--wa-color-symbol-class, #267f99);
  }

  .hljs-property,
  .hljs-name {
    color: var(--wa-color-symbol-property, var(--wa-color-text-normal));
  }

  .hljs-operator,
  .hljs-punctuation {
    color: var(--wa-color-text-normal);
  }

  .hljs-section,
  .hljs-selector-class,
  .hljs-selector-id {
    color: var(--wa-color-text-link);
  }

  .hljs-meta,
  .hljs-meta .hljs-keyword,
  .hljs-meta .hljs-string {
    color: var(--wa-color-symbol-keyword, var(--wa-color-text-link));
  }

  .hljs-addition {
    background-color: var(--wa-color-diff-inserted);
    color: var(--wa-color-git-added, #3fb950);
  }

  .hljs-deletion {
    background-color: var(--wa-color-diff-removed);
    color: var(--wa-color-git-deleted, #b31d28);
  }

  .hljs-emphasis {
    font-style: italic;
  }

  .hljs-strong {
    font-weight: var(--font-weight-bold);
  }

  .hljs-symbol,
  .hljs-bullet {
    color: var(--wa-color-symbol-constant, #36acaa);
  }

  .hljs-link {
    color: var(--wa-color-text-link);
    text-decoration: underline;
  }
`;
