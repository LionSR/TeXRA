import { css, type CSSResult } from 'lit';

/** Markdown content styles for rendered markdown in log entries. */
export const markdownStyles: CSSResult = css`
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

  /* Heading sizes descend with level (agent markdown leans on ##/### heavily,
     so a flat scale flattens transcript structure). Headings take the normal
     text color: link hue is reserved for actual links, which now underline. */
  .markdown-content :is(h1, h2, h3, h4) {
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-heading);
    margin: 1em 0 0.5em;
  }

  .markdown-content h1 {
    font-size: var(--font-size-h1);
    font-weight: var(--font-weight-semibold);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--wa-space-2xs);
  }

  .markdown-content h2 {
    font-size: var(--font-size-h2);
    font-weight: var(--font-weight-semibold);
    margin-top: var(--wa-space-s);
    margin-bottom: var(--wa-space-2xs);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--wa-space-3xs);
  }

  .markdown-content h3 {
    font-size: var(--font-size-h3);
    font-weight: var(--font-weight-semibold);
  }

  .markdown-content h4 {
    font-size: var(--font-size);
    font-weight: var(--font-weight-medium);
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
    /* Items wrap, so they get the prose line-height, not the heading one. */
    line-height: var(--line-height-normal);

    & + li {
      margin-top: 0.1em;
    }
  }

  .markdown-content code {
    background-color: var(--wa-color-surface-lowered);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    border-radius: var(--border-radius);
    /* Mono so paths/flags/identifiers stay distinct from prose; 0.9em
       compensates for mono's larger x-height against body text. */
    font-family: var(--wa-font-family-mono);
    font-size: 0.9em;
  }

  .markdown-content pre {
    padding: var(--wa-space-xs) var(--wa-space-s);
    margin: 0.5em 0;
    border-radius: var(--border-radius);
    background-color: var(--wa-color-surface-lowered);
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
    color: var(--wa-color-symbol-keyword);
  }

  /* Radius only — the ring comes from focusRingStyles. */
  .markdown-content .latex-ref:focus-visible {
    border-radius: var(--border-radius-small);
  }

  /* Links in prose underline at rest — link hue alone is not a reliable
     3:1 separation from surrounding text across host themes. */
  .markdown-content a {
    color: var(--color-text-link);
    text-decoration: underline;
  }

  .markdown-content blockquote {
    border-inline-start: var(--border-medium) solid
      var(--wa-color-activity-badge-bg);
    margin: var(--wa-space-xs) 0;
    padding-inline-start: var(--wa-space-l);
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
      background-color: var(--wa-color-editor-line-highlight);
      text-align: start;
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
    background-color: var(--wa-color-surface-border);
    border: none;
  }

  .markdown-content em strong,
  .markdown-content strong em {
    color: var(--wa-color-brand-on-quiet);
  }

  .markdown-content :is(h2 + p, p + p, h1 + h1, h2 + h2, h3 + h3, h4 + h4) {
    margin-top: 0.3em;
  }
`;
