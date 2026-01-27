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
    padding: var(--spacing-tiny) var(--spacing-small);
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    border-bottom: var(--border-thin) solid var(--color-border);
    font-size: var(--font-size-xs);
  }

  .code-block-language {
    color: var(--vscode-descriptionForeground, #888);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .code-block pre {
    margin: 0;
    padding: var(--spacing-small);
    background-color: var(--background-code);
    border: var(--border-thin) solid var(--vscode-editorWidget-border);
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
    padding: var(--spacing-tiny) var(--spacing-small);
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground, #888);
    cursor: pointer;
    border-radius: var(--border-radius-small);
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .code-block-copy {
    &:hover {
      background-color: var(
        --vscode-toolbar-hoverBackground,
        rgba(90, 93, 94, 0.31)
      );
      color: var(--vscode-foreground);
    }

    &:active {
      background-color: var(
        --vscode-toolbar-activeBackground,
        rgba(99, 102, 103, 0.31)
      );
    }

    &.copied {
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    }
  }

  /* Syntax highlighted code blocks */
  pre.hljs {
    padding: var(--spacing-small);
    overflow-x: auto;
  }

  pre.hljs code {
    background: transparent;
    padding: 0;
  }

  /* Highlight.js theme - VS Code colors for Shadow DOM */
  pre.hljs,
  .hljs {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }

  .hljs-comment,
  .hljs-quote {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .hljs-keyword,
  .hljs-selector-tag,
  .hljs-tag {
    color: var(
      --vscode-symbolIcon-keywordForeground,
      var(--vscode-textLink-foreground)
    );
  }

  .hljs-string,
  .hljs-doctag,
  .hljs-regexp,
  .hljs-template-tag,
  .hljs-template-variable {
    color: var(--vscode-debugTokenExpression-string, #a31515);
  }

  .hljs-number,
  .hljs-literal,
  .hljs-built_in,
  .hljs-type {
    color: var(--vscode-debugTokenExpression-number, #098658);
  }

  .hljs-variable,
  .hljs-params,
  .hljs-attr {
    color: var(
      --vscode-symbolIcon-variableForeground,
      var(--vscode-editor-foreground)
    );
  }

  .hljs-function,
  .hljs-title,
  .hljs-title.function_ {
    color: var(--vscode-symbolIcon-functionForeground, #795e26);
  }

  .hljs-class .hljs-title,
  .hljs-title.class_,
  .hljs-title.class_.inherited__ {
    color: var(--vscode-symbolIcon-classForeground, #267f99);
  }

  .hljs-property,
  .hljs-name {
    color: var(
      --vscode-symbolIcon-propertyForeground,
      var(--vscode-editor-foreground)
    );
  }

  .hljs-operator,
  .hljs-punctuation {
    color: var(--vscode-editor-foreground);
  }

  .hljs-section,
  .hljs-selector-class,
  .hljs-selector-id {
    color: var(--vscode-textLink-foreground);
  }

  .hljs-meta,
  .hljs-meta .hljs-keyword,
  .hljs-meta .hljs-string {
    color: var(--vscode-symbolIcon-keywordForeground, #0000ff);
  }

  .hljs-addition {
    background-color: var(--vscode-diffEditor-insertedTextBackground);
    color: var(--vscode-gitDecoration-addedResourceForeground, #22863a);
  }

  .hljs-deletion {
    background-color: var(--vscode-diffEditor-removedTextBackground);
    color: var(--vscode-gitDecoration-deletedResourceForeground, #b31d28);
  }

  .hljs-emphasis {
    font-style: italic;
  }

  .hljs-strong {
    font-weight: bold;
  }

  .hljs-symbol,
  .hljs-bullet {
    color: var(--vscode-symbolIcon-constantForeground, #36acaa);
  }

  .hljs-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
  }
`;
