/**
 * Model List Renderer
 */
import { CAPABILITY_ICONS } from '../constants.js';

/**
 * Render capability icons for a model
 */
export function renderCapabilities(capabilities) {
  if (!capabilities) return '';

  const icons = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (value && CAPABILITY_ICONS[key]) {
      const { icon, title } = CAPABILITY_ICONS[key];
      icons.push(`<span title="${title}">${icon}</span>`);
    }
  }

  return icons.length > 0
    ? `<span class="model-capabilities">${icons.join('')}</span>`
    : '';
}

/**
 * Render a model status indicator
 */
export function renderModelStatus(status) {
  switch (status) {
    case 'configured':
    case 'env':
      return '<span class="model-status ready">Ready</span>';
    case 'server':
      return '<span class="model-status server">Server</span>';
    case 'missing':
      return '<span class="model-status missing">No key</span>';
    default:
      return '';
  }
}

/**
 * Format context window size
 */
export function formatContextWindow(contextWindow) {
  if (!contextWindow) return '';
  if (contextWindow >= 1000000) {
    return `${(contextWindow / 1000000).toFixed(1)}M`;
  }
  if (contextWindow >= 1000) {
    return `${Math.round(contextWindow / 1000)}K`;
  }
  return contextWindow.toString();
}

/**
 * Format price (per 1M tokens)
 */
export function formatPrice(inputPrice, outputPrice) {
  if (inputPrice === undefined && outputPrice === undefined) return '';
  const input = inputPrice !== undefined ? `$${inputPrice}` : '?';
  const output = outputPrice !== undefined ? `$${outputPrice}` : '?';
  return `${input}/${output}`;
}

/**
 * Render a single model item
 */
export function renderModelItem(model, isEnabled) {
  const capabilities = renderCapabilities(model.capabilities);
  const status = renderModelStatus(model.status);
  const context = formatContextWindow(model.contextWindow);
  const price = formatPrice(model.inputPrice, model.outputPrice);

  return `
    <div class="model-item" data-model-id="${model.id}">
      <vscode-checkbox ${isEnabled ? 'checked' : ''} data-model-id="${model.id}">
      </vscode-checkbox>
      <div class="model-info">
        <span class="model-name" title="${model.fullName || model.name}">${model.name}</span>
        <span class="model-provider">${model.provider}</span>
        ${context ? `<span class="model-context">${context}</span>` : ''}
        ${price ? `<span class="model-cost">${price}</span>` : ''}
        ${capabilities}
        ${status}
      </div>
    </div>
  `;
}

/**
 * Render a list of models
 */
export function renderModelList(models, enabledModels) {
  if (!models || models.length === 0) {
    return '<p class="empty-state">No models available</p>';
  }

  return models
    .map((model) => renderModelItem(model, enabledModels.has(model.id)))
    .join('');
}
