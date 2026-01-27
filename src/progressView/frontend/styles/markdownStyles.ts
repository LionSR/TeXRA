// Third-party imports
import { css } from 'lit';

/**
 * Markdown content styles for rendered markdown in log entries.
 */
export const markdownStyles = css`
  .katex-mathml {
    display: none;
  }

  .markdown-content {
    overflow: visible;
  }

  :is(.markdown-content, .banner-content, [class^='banner-content--'])
    > :first-child {
    margin-top: 0;
  }

  :is(.markdown-content, .banner-content, [class^='banner-content--'])
    > :last-child {
    margin-bottom: 0;
  }

  .banner-content--model {
    padding: 0;
    white-space: normal;
  }

  .banner-content--model pre {
    white-space: pre-wrap;
  }

  :is(.banner-content, .banner-content--model) p {
    margin: 0.3em 0;
  }

  :is(.banner-content, .banner-content--model) p:first-child {
    margin-top: 0;
  }

  :is(.banner-content, .banner-content--model) p:last-child {
    margin-bottom: 0;
  }

  .markdown-content :is(h1, h2, h3, h4) {
    color: var(--vscode-textLink-foreground, #3794ff);
    font-size: var(--font-size-lg);
    font-weight: 600;
    line-height: 1.25;
    margin: 1em 0 0.5em;
  }

  .markdown-content h1 {
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--spacing-small);
  }

  .markdown-content h2 {
    padding-left: var(--spacing-medium);
    margin-top: var(--spacing-large);
    margin-bottom: var(--spacing-small);
    border-left: var(--border-thick) solid
      var(--vscode-activityBarBadge-background);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--spacing-tiny);
    border-radius: var(--border-radius) 0 0 var(--border-radius);
    color: var(--color-text-link);
  }

  .markdown-content p {
    margin: 0.5em 0;
  }

  .markdown-content p:last-child {
    margin-bottom: 0;
  }

  .markdown-content ul,
  .markdown-content ol {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }

  .markdown-content li {
    margin: 0 0 0.2em 0;
    line-height: 1.25;
  }

  .markdown-content li + li {
    margin-top: 0.1em;
  }

  .markdown-content code {
    background-color: var(--vscode-textCodeBlock-background);
    padding: var(--spacing-tiny) var(--spacing-small);
    border-radius: var(--border-radius);
    font-family: var(--font-family);
    font-size: var(--font-size-sm);
  }

  .markdown-content pre {
    padding: var(--spacing-medium) var(--spacing-large);
    margin: 0.5em 0;
    border-radius: var(--border-radius);
    background-color: var(--vscode-textCodeBlock-background);
    border-left: var(--spacing-tiny) solid
      var(--vscode-activityBarBadge-background);
    overflow-x: auto;
  }

  .markdown-content pre code {
    background-color: transparent;
    padding: 0;
    display: block;
    line-height: 1.4;
  }

  .markdown-content .latex-ref {
    font-family: var(--font-family);
    color: var(--vscode-symbolIcon-keywordForeground);
  }

  .markdown-content a {
    color: var(--color-text-link);
    text-decoration: none;
  }

  .markdown-content a:hover {
    text-decoration: underline;
  }

  .markdown-content blockquote {
    border-left: var(--border-thick) solid
      var(--vscode-activityBarBadge-background);
    margin: var(--spacing-medium) 0;
    padding-left: var(--spacing-xlarge);
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .markdown-content table {
    border-collapse: collapse;
    width: 100%;
    margin: var(--spacing-xlarge) 0;
  }

  .markdown-content table th,
  .markdown-content table td {
    border: var(--border-thin) solid var(--color-border);
    padding: var(--spacing-small) var(--spacing-large);
  }

  .markdown-content table th {
    background-color: var(--vscode-editor-lineHighlightBackground);
    text-align: left;
  }

  .markdown-content img {
    max-width: 100%;
  }

  .markdown-content strong {
    color: var(--vscode-editor-foreground);
    font-weight: 600;
  }

  .markdown-content em {
    font-style: italic;
  }

  .markdown-content hr {
    margin: 0.7em 0;
    height: var(--border-thin);
    background-color: var(--vscode-editorWidget-border);
    border: none;
  }

  .markdown-content em strong,
  .markdown-content strong em {
    color: var(--vscode-editorInfo-foreground);
  }

  .banner-content--scratchpad p:has(strong:first-child) {
    border-left: calc(var(--spacing-small) - 1px) solid
      var(--vscode-notificationsInfoIcon-foreground);
    padding-left: var(--spacing-medium);
  }

  .markdown-content h2 + p {
    margin-top: 0.3em;
  }

  .markdown-content p + p {
    margin-top: 0.3em;
  }

  .markdown-content h1 + h1,
  .markdown-content h2 + h2,
  .markdown-content h3 + h3,
  .markdown-content h4 + h4 {
    margin-top: 0.3em;
  }
`;
