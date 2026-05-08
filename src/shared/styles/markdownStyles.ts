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

    &:first-child {
      margin-top: 0;
    }

    &:last-child {
      margin-bottom: 0;
    }
  }

  .markdown-content :is(h1, h2, h3, h4) {
    color: var(--texra-textLink-foreground, #3794ff);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
    margin: 1em 0 0.5em;
  }

  .markdown-content h1 {
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--wa-space-2xs);
  }

  .markdown-content h2 {
    padding-left: var(--wa-space-xs);
    margin-top: var(--wa-space-s);
    margin-bottom: var(--wa-space-2xs);
    border-left: var(--border-thick) solid
      var(--texra-activityBarBadge-background);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--wa-space-3xs);
    border-radius: var(--border-radius) 0 0 var(--border-radius);
    color: var(--color-text-link);
  }

  .markdown-content p {
    margin: 0.5em 0;
  }

  .markdown-content :is(p, ul, ol):last-child {
    margin-bottom: 0;
  }

  .markdown-content :is(ul, ol) {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }

  .markdown-content li {
    margin: 0 0 0.2em 0;
    line-height: var(--line-height-heading);

    & + li {
      margin-top: 0.1em;
    }
  }

  .markdown-content code {
    background-color: var(--texra-textCodeBlock-background);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    border-radius: var(--border-radius);
    font-family: var(--font-family);
    font-size: var(--font-size-sm);
  }

  .markdown-content pre {
    padding: var(--wa-space-xs) var(--wa-space-s);
    margin: 0.5em 0;
    border-radius: var(--border-radius);
    background-color: var(--texra-textCodeBlock-background);
    border-left: var(--wa-space-3xs) solid
      var(--texra-activityBarBadge-background);
    overflow-x: auto;
  }

  .markdown-content pre code {
    background-color: transparent;
    padding: 0;
    display: block;
    line-height: var(--line-height-normal);
  }

  .markdown-content .latex-ref {
    font-family: var(--font-family);
    color: var(--texra-symbolIcon-keywordForeground);
  }

  .markdown-content a {
    color: var(--color-text-link);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  .markdown-content blockquote {
    border-left: var(--border-thick) solid
      var(--texra-activityBarBadge-background);
    margin: var(--wa-space-xs) 0;
    padding-left: var(--wa-space-l);
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .markdown-content table {
    border-collapse: collapse;
    width: 100%;
    margin: var(--wa-space-l) 0;

    :is(th, td) {
      border: var(--border-thin) solid var(--color-border);
      padding: var(--wa-space-2xs) var(--wa-space-s);
    }

    th {
      background-color: var(--texra-editor-lineHighlightBackground);
      text-align: left;
    }
  }

  .markdown-content img {
    max-width: 100%;
  }

  .markdown-content strong {
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-semibold);
  }

  .markdown-content em {
    font-style: italic;
  }

  .markdown-content hr {
    margin: 0.7em 0;
    height: var(--border-thin);
    background-color: var(--texra-editorWidget-border);
    border: none;
  }

  .markdown-content em strong,
  .markdown-content strong em {
    color: var(--texra-editorInfo-foreground);
  }

  .banner-content--scratchpad p:has(strong:first-child) {
    border-left: calc(var(--wa-space-2xs) - 1px) solid
      var(--texra-notificationsInfoIcon-foreground);
    padding-left: var(--wa-space-xs);
  }

  .markdown-content :is(h2 + p, p + p, h1 + h1, h2 + h2, h3 + h3, h4 + h4) {
    margin-top: 0.3em;
  }
`;
