/**
 * Provider Renderer
 */
import { PROVIDERS } from '../constants.js';

/**
 * Render provider status indicator
 */
export function renderProviderStatus(status) {
  switch (status) {
    case 'configured':
      return `
        <span class="status-icon ready codicon codicon-check"></span>
        <span class="status-text">API Key</span>
      `;
    case 'env':
      return `
        <span class="status-icon ready codicon codicon-terminal"></span>
        <span class="status-text">Env Var</span>
      `;
    case 'missing':
      return `
        <span class="status-icon missing codicon codicon-close"></span>
        <span class="status-text">No Key</span>
      `;
    case 'server':
      return `
        <span class="status-icon codicon codicon-server"></span>
        <span class="status-text">Server</span>
      `;
    default:
      return '';
  }
}

/**
 * Render a provider collapsible header
 */
export function renderProviderHeader(provider) {
  const meta = PROVIDERS[provider.id] || { name: provider.name };
  const status = renderProviderStatus(provider.status);

  return `
    <div class="provider-header">
      <span class="provider-name">${meta.name || provider.name}</span>
      <span class="provider-count">(${provider.modelCount} models)</span>
      <div class="provider-status">
        ${status}
        <vscode-button appearance="secondary" data-provider="${provider.id}" data-action="configure">
          Configure
        </vscode-button>
      </div>
    </div>
  `;
}

/**
 * Render a provider collapsible section
 */
export function renderProviderCollapsible(
  provider,
  modelsHtml,
  isOpen = false,
) {
  const header = renderProviderHeader(provider);

  return `
    <vscode-collapsible
      title="${provider.name}"
      data-provider="${provider.id}"
      ${isOpen ? 'open' : ''}
    >
      <div slot="header">${header}</div>
      <div class="provider-models">
        ${modelsHtml}
      </div>
    </vscode-collapsible>
  `;
}

/**
 * Get provider display name
 */
export function getProviderDisplayName(providerId) {
  const meta = PROVIDERS[providerId];
  return meta ? meta.name : providerId;
}

/**
 * Get provider key URL
 */
export function getProviderKeyUrl(providerId) {
  const meta = PROVIDERS[providerId];
  return meta ? meta.keyUrl : '#';
}

/**
 * Get provider environment variable name
 */
export function getProviderEnvVar(providerId) {
  const meta = PROVIDERS[providerId];
  return meta ? meta.envVar : `${providerId.toUpperCase()}_API_KEY`;
}
