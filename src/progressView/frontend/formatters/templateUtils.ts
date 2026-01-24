// Local imports - HTML encoding
import { encodeHtml } from '@common/modules/htmlEncoding.js';

const TEMPLATE_HTML: Record<string, string> = {
  bannerDetailsTemplate: `
    <details class="banner-details">
      <summary class="details-summary">
        <i class="codicon toggle-icon"></i>
        <i class="codicon icon"></i>
        <span class="label"></span>
        <vscode-toolbar-button class="banner-content-copy" icon="copy" aria-label="Copy"></vscode-toolbar-button>
      </summary>
      <div class="banner-content"></div>
    </details>
  `,
  toolUseTemplate: `
    <details class="banner-details tool-use-details">
      <summary class="details-summary">
        <i class="codicon toggle-icon"></i>
        <i class="codicon"></i>
        <span class="tool-use-title"></span>
      </summary>
      <div class="banner-content"></div>
    </details>
  `,
  fileListDetailsTemplate: `
    <details class="banner-details file-list-details">
      <summary class="details-summary">
        <i class="codicon toggle-icon"></i>
        <i class="codicon codicon-files"></i>
        <span class="summary-text">Files</span>
      </summary>
      <ul class="file-list-content"></ul>
    </details>
  `,
  missingOutputsDetailsTemplate: `
    <details class="banner-details missing-outputs-details">
      <summary class="details-summary">
        <i class="codicon toggle-icon"></i>
        <i class="codicon codicon-warning"></i>
        <span class="summary-text">Missing outputs</span>
      </summary>
      <ul class="file-list-content"></ul>
    </details>
  `,
  latexdiffDetailsTemplate: `
    <details class="banner-details latexdiff-details">
      <summary class="details-summary">
        <i class="codicon toggle-icon"></i>
        <i class="codicon codicon-diff"></i>
        <span class="summary-text">Latexdiff</span>
      </summary>
      <div class="latexdiff-content"></div>
    </details>
  `,
  statisticsDetailsTemplate: `
    <details class="banner-details statistics-details">
      <summary class="details-summary">
        <i class="codicon toggle-icon"></i>
        <i class="codicon codicon-graph"></i>
        <span class="summary-text">Statistics</span>
      </summary>
      <div class="statistics-content"></div>
    </details>
  `,
  contextManagementTemplate: `
    <details class="banner-details context-management-details">
      <summary class="details-summary">
        <i class="codicon toggle-icon"></i>
        <i class="codicon context-management-icon"></i>
        <span class="context-management-title"></span>
      </summary>
      <div class="context-management-content"></div>
    </details>
  `,
  userMessageTemplate: `
    <div class="user-message-container">
      <div class="user-message">
        <div class="user-message-header">
          <i class="codicon codicon-account user-message-icon"></i>
          <span class="user-message-timestamp"></span>
        </div>
        <div class="user-message-content"></div>
      </div>
    </div>
  `,
  groupHeaderTemplate: `
    <summary class="log-group-header">
      <span class="group-status-icon"></span>
      <span class="group-title"></span>
      <span class="group-time group-start-time"></span>
      <span class="group-bullet">${encodeHtml('•')}</span>
      <span class="group-time group-duration"></span>
    </summary>
  `,
  groupDetailsTemplate: `
    <div class="log-group">
      <div class="log-group-content"></div>
    </div>
  `,
};

export function renderTemplate(templateId: string): HTMLElement | null {
  const html = TEMPLATE_HTML[templateId];
  if (!html) {
    console.warn(`Template ${templateId} not found`);
    return null;
  }
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;
  return element ? (element.cloneNode(true) as HTMLElement) : null;
}

export function createFromTemplate(
  templateId: string,
  replacements: {
    text?: Record<string, string>;
    attributes?: Record<string, Record<string, string>>;
    dataset?: Record<string, Record<string, string>>;
  } = {},
): HTMLElement | null {
  const element = renderTemplate(templateId);
  if (!element) return null;

  const { text = {}, attributes = {}, dataset = {} } = replacements;
  const apply = (selector: string, fn: (el: Element) => void) => {
    const target = selector ? element.querySelector(selector) : element;
    if (target) fn(target);
  };

  Object.entries(text).forEach(([selector, value]) => {
    apply(selector, (el) => {
      el.textContent = value;
    });
  });

  Object.entries(attributes).forEach(([selector, attrs]) => {
    apply(selector, (el) => {
      Object.entries(attrs).forEach(([attr, val]) => {
        el.setAttribute(attr, val);
      });
    });
  });

  Object.entries(dataset).forEach(([selector, data]) => {
    apply(selector, (el) => {
      Object.entries(data).forEach(([key, val]) => {
        (el as HTMLElement).dataset[key] = val;
      });
    });
  });

  return element;
}
