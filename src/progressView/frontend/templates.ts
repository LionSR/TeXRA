const TEMPLATES: Array<{ id: string; html: string }> = [
  {
    id: 'bannerDetailsTemplate',
    html: `
      <details class="banner-details">
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon icon"></i>
          <span class="label"></span>
          <vscode-toolbar-button class="banner-content-copy" icon="copy"></vscode-toolbar-button>
        </summary>
        <div class="banner-content log-entry-content"></div>
      </details>
    `,
  },
  {
    id: 'toolUseTemplate',
    html: `
      <details class="banner-details tool-use-details">
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon codicon-wrench"></i>
          <span class="tool-use-title">Tool Use</span>
        </summary>
        <div class="banner-content log-entry-content"></div>
      </details>
    `,
  },
  {
    id: 'fileListDetailsTemplate',
    html: `
      <details class="banner-details file-list-details">
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon codicon-file"></i>
          <span class="summary-text">Files</span>
        </summary>
        <ul class="file-list-content"></ul>
      </details>
    `,
  },
  {
    id: 'missingOutputsDetailsTemplate',
    html: `
      <details class="banner-details file-list-details">
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon codicon-warning"></i>
          <span class="summary-text">Missing outputs</span>
        </summary>
        <ul class="file-list-content"></ul>
      </details>
    `,
  },
  {
    id: 'latexdiffDetailsTemplate',
    html: `
      <details class="banner-details latexdiff-details">
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon codicon-diff"></i>
          <span class="summary-text">Latexdiff results</span>
        </summary>
        <ul class="latexdiff-content"></ul>
      </details>
    `,
  },
  {
    id: 'statisticsDetailsTemplate',
    html: `
      <details class="banner-details statistics-details">
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon codicon-graph"></i>
          <span class="summary-text">Statistics</span>
        </summary>
        <div class="statistics-content"></div>
      </details>
    `,
  },
  {
    id: 'contextManagementTemplate',
    html: `
      <details class="banner-details context-management-details">
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon codicon-history context-management-icon"></i>
          <span class="context-management-title">Context Management</span>
        </summary>
        <div class="context-management-content"></div>
      </details>
    `,
  },
  {
    id: 'userMessageTemplate',
    html: `
      <div class="user-message-container">
        <div class="user-message">
          <div class="user-message-header">
            <i class="codicon codicon-comment user-message-icon"></i>
            <span class="user-message-timestamp"></span>
          </div>
          <div class="user-message-content"></div>
        </div>
      </div>
    `,
  },
  {
    id: 'groupDetailsTemplate',
    html: `
      <div class="log-group">
        <div class="log-group-content"></div>
      </div>
    `,
  },
  {
    id: 'groupHeaderTemplate',
    html: `
      <summary class="log-group-header">
        <span class="group-status-icon"></span>
        <span class="group-title"></span>
        <span class="group-time">
          <span class="group-start-time"></span>
          <span class="group-duration"></span>
        </span>
      </summary>
    `,
  },
];

export function registerProgressViewTemplates(): void {
  for (const { id, html } of TEMPLATES) {
    if (document.getElementById(id)) continue;
    const template = document.createElement('template');
    template.id = id;
    template.innerHTML = html.trim();
    document.body.appendChild(template);
  }
}
