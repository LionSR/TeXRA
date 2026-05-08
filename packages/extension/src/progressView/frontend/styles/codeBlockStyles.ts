// Third-party imports
import { css } from 'lit';

/**
 * Code block styles for syntax highlighted code with language badge and copy button.
 * Used by buildCodeBlock() in htmlBuilders.
 */
export const codeBlockStyles = css`
  .code-block {
    position: relative;
    border-radius: var(--border-radius-small);
    overflow: hidden;
  }

  .code-block-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    background-color: var(--texra-editorGroupHeader-tabsBackground);
    border-bottom: var(--border-thin) solid var(--color-border);
    font-size: var(--font-size-xs);
  }

  .code-block-language {
    color: var(--texra-descriptionForeground, #888);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: var(--font-weight-medium);
  }

  .code-block pre {
    margin: 0;
    padding: var(--wa-space-2xs);
    background-color: var(--wa-color-surface-default);
    border: var(--border-thin) solid var(--texra-editorWidget-border);
    border-radius: 0;
    overflow-x: auto;
  }

  .code-block pre code {
    display: block;
  }

  .code-block-copy {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border: none;
    background: transparent;
    color: var(--texra-descriptionForeground, #888);
    cursor: pointer;
    border-radius: var(--border-radius-small);
    transition:
      background-color var(--transition-fast),
      color var(--transition-fast),
      transform var(--transition-fast);

    &:hover {
      background-color: var(
        --texra-toolbar-hoverBackground,
        rgba(90, 93, 94, 0.31)
      );
      color: var(--wa-color-text-normal);
    }

    &:active {
      background-color: var(
        --texra-toolbar-activeBackground,
        rgba(99, 102, 103, 0.31)
      );
    }

    &.copied {
      color: var(--texra-gitDecoration-addedResourceForeground, #3fb950);
    }

    &:focus-visible {
      outline: var(--border-thin) solid var(--wa-color-focus);
      outline-offset: 1px;
    }
  }

  /* Syntax highlighted code blocks */
  pre.hljs {
    padding: var(--wa-space-2xs);
    overflow-x: auto;
  }

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
    color: var(--texra-symbolIcon-keywordForeground, var(--wa-color-text-link));
  }

  .hljs-string,
  .hljs-doctag,
  .hljs-regexp,
  .hljs-template-tag,
  .hljs-template-variable {
    color: var(--texra-debugTokenExpression-string, #a31515);
  }

  .hljs-number,
  .hljs-literal,
  .hljs-built_in,
  .hljs-type {
    color: var(--texra-debugTokenExpression-number, #098658);
  }

  .hljs-variable,
  .hljs-params,
  .hljs-attr {
    color: var(
      --texra-symbolIcon-variableForeground,
      var(--wa-color-text-normal)
    );
  }

  .hljs-function,
  .hljs-title,
  .hljs-title.function_ {
    color: var(--texra-symbolIcon-functionForeground, #795e26);
  }

  .hljs-class .hljs-title,
  .hljs-title.class_,
  .hljs-title.class_.inherited__ {
    color: var(--texra-symbolIcon-classForeground, #267f99);
  }

  .hljs-property,
  .hljs-name {
    color: var(
      --texra-symbolIcon-propertyForeground,
      var(--wa-color-text-normal)
    );
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
    color: var(--texra-symbolIcon-keywordForeground, #0000ff);
  }

  .hljs-addition {
    background-color: var(--texra-diffEditor-insertedTextBackground);
    color: var(--texra-gitDecoration-addedResourceForeground, #22863a);
  }

  .hljs-deletion {
    background-color: var(--texra-diffEditor-removedTextBackground);
    color: var(--texra-gitDecoration-deletedResourceForeground, #b31d28);
  }

  .hljs-emphasis {
    font-style: italic;
  }

  .hljs-strong {
    font-weight: var(--font-weight-bold);
  }

  .hljs-symbol,
  .hljs-bullet {
    color: var(--texra-symbolIcon-constantForeground, #36acaa);
  }

  .hljs-link {
    color: var(--wa-color-text-link);
    text-decoration: underline;
  }
`;
