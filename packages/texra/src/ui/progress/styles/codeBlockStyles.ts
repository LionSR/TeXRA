// Third-party imports
import { css } from 'lit';

// Local imports - shared styles
import { overlineDeclarations } from '@ui/styles/commonViewStyles';

/**
 * Code block styles for syntax highlighted code with language badge and copy button.
 * Used by buildCodeBlock() in htmlBuilders.
 */
export const codeBlockStyles = css`
  .code-block {
    position: relative;
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius-medium);
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
    ${overlineDeclarations}
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
    color: var(--color-text-secondary);
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
    color: var(--wa-color-debug-string);
  }

  .hljs-number,
  .hljs-literal,
  .hljs-built_in,
  .hljs-type {
    color: var(--wa-color-debug-number);
  }

  .hljs-variable,
  .hljs-params,
  .hljs-attr {
    color: var(--wa-color-symbol-variable, var(--wa-color-text-normal));
  }

  .hljs-function,
  .hljs-title,
  .hljs-title.function_ {
    color: var(--wa-color-symbol-function);
  }

  .hljs-class .hljs-title,
  .hljs-title.class_,
  .hljs-title.class_.inherited__ {
    color: var(--wa-color-symbol-class);
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
    color: var(--wa-color-git-added);
  }

  .hljs-deletion {
    background-color: var(--wa-color-diff-removed);
    color: var(--wa-color-git-deleted);
  }

  .hljs-emphasis {
    font-style: italic;
  }

  .hljs-strong {
    font-weight: var(--font-weight-bold);
  }

  .hljs-symbol,
  .hljs-bullet {
    color: var(--wa-color-symbol-constant);
  }

  .hljs-link {
    color: var(--wa-color-text-link);
    text-decoration: underline;
  }
`;
