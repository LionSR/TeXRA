/**
 * Models Tab
 */
import { vscode } from '@common/webviewContext.js';
import { debounce } from '@common/debounce.js';
import { settingsViewState } from '../settingsViewState.js';
import {
  SETTINGS_VIEW_COMMANDS,
  ELEMENT_IDS,
  PROVIDERS,
} from '../constants.js';
import { renderModelList } from '../uiManagers/ModelListRenderer.js';
import {
  renderProviderCollapsible,
  getProviderDisplayName,
  getProviderKeyUrl,
  getProviderEnvVar,
} from '../uiManagers/ProviderRenderer.js';

export class ModelsTab {
  constructor() {
    this._elements = null;
    this._debouncedSave = debounce(() => this.saveModels(), 500);
    this._modal = null;
  }

  initialize() {
    this._elements = {
      recommendedModelsList: document.getElementById(
        ELEMENT_IDS.RECOMMENDED_MODELS_LIST,
      ),
      providersList: document.getElementById(ELEMENT_IDS.PROVIDERS_LIST),
      modelCount: document.getElementById(ELEMENT_IDS.MODEL_COUNT),
    };

    this.attachEventListeners();
  }

  attachEventListeners() {
    const { recommendedModelsList, providersList } = this._elements;

    // Model checkbox changes
    if (recommendedModelsList) {
      recommendedModelsList.addEventListener('change', (e) => {
        this.handleModelToggle(e);
      });
    }

    if (providersList) {
      providersList.addEventListener('change', (e) => {
        this.handleModelToggle(e);
      });

      // Configure button clicks
      providersList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="configure"]');
        if (btn) {
          const providerId = btn.dataset.provider;
          this.openProviderModal(providerId);
        }
      });
    }
  }

  handleModelToggle(event) {
    const checkbox = event.target.closest('vscode-checkbox');
    if (!checkbox || !checkbox.dataset.modelId) return;

    const modelId = checkbox.dataset.modelId;
    const isEnabled = checkbox.checked;

    settingsViewState.toggleModel(modelId, isEnabled);
    this.updateModelCount();
    this._debouncedSave();
  }

  saveModels() {
    const enabledModels = settingsViewState.getEnabledModelsArray();
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_MODELS,
      models: enabledModels,
    });
    settingsViewState.clearPendingChanges();
  }

  updateModelCount() {
    const { modelCount } = this._elements;
    if (modelCount) {
      const count = settingsViewState.enabledModels.size;
      modelCount.textContent = `Selected: ${count} model${count !== 1 ? 's' : ''}`;
    }
  }

  openProviderModal(providerId) {
    const provider = settingsViewState.providers.find(
      (p) => p.id === providerId,
    );
    if (!provider) return;

    // Get or create modal
    if (!this._modal) {
      const template = document.getElementById('providerModalTemplate');
      if (!template) return;

      this._modal = template.content.cloneNode(true).firstElementChild;
      document.body.appendChild(this._modal);
      this.attachModalEventListeners();
    }

    // Populate modal with provider data
    const meta = PROVIDERS[providerId] || {};
    this._modal.querySelector('.provider-name').textContent =
      meta.name || providerId;
    this._modal.querySelector('.key-url').textContent = meta.keyUrl || '';
    this._modal.querySelector('.key-url').href = meta.keyUrl || '#';
    this._modal.querySelector('.env-var').textContent =
      meta.envVar || `${providerId.toUpperCase()}_API_KEY`;
    this._modal.querySelector('.api-key-input').value = '';
    this._modal.querySelector('.custom-endpoint').placeholder = '';
    this._modal.querySelector('.streaming-enabled').checked =
      provider.streamingEnabled !== false;

    // Store provider ID for save action
    this._modal.dataset.providerId = providerId;

    // Show modal
    this._modal.style.display = 'flex';
  }

  attachModalEventListeners() {
    const modal = this._modal;
    if (!modal) return;

    // Close button
    modal.querySelector('.modal-close').addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Cancel button
    modal.querySelector('.modal-cancel').addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Save button
    modal.querySelector('.modal-save').addEventListener('click', () => {
      const providerId = modal.dataset.providerId;
      const apiKey = modal.querySelector('.api-key-input').value.trim();

      if (apiKey) {
        vscode.postMessage({
          command: SETTINGS_VIEW_COMMANDS.SET_API_KEY,
          provider: providerId,
          key: apiKey,
        });
      }

      modal.style.display = 'none';
    });

    // Clear key button
    modal.querySelector('.clear-key').addEventListener('click', () => {
      const providerId = modal.dataset.providerId;
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_API_KEY,
        provider: providerId,
      });
      modal.style.display = 'none';
    });

    // Toggle visibility button
    modal.querySelector('.toggle-visibility').addEventListener('click', (e) => {
      const input = modal.querySelector('.api-key-input');
      const icon = e.currentTarget.querySelector('.codicon');
      if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'codicon codicon-eye-closed';
      } else {
        input.type = 'password';
        icon.className = 'codicon codicon-eye';
      }
    });

    // Key URL link
    modal.querySelector('.key-url').addEventListener('click', (e) => {
      e.preventDefault();
      const providerId = modal.dataset.providerId;
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_URL,
        provider: providerId,
      });
    });

    // Backdrop click to close (modal element IS the backdrop)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
  }

  render(state) {
    this.renderRecommendedModels(state);
    this.renderProviders(state);
    this.updateModelCount();
  }

  renderRecommendedModels(state) {
    const { recommendedModelsList } = this._elements;
    if (!recommendedModelsList) return;

    const recommendedModels = state.getRecommendedModels();
    recommendedModelsList.innerHTML = renderModelList(
      recommendedModels,
      state.enabledModels,
    );
  }

  renderProviders(state) {
    const { providersList } = this._elements;
    if (!providersList) return;

    const html = state.providers
      .map((provider) => {
        const providerModels = state.getModelsByProvider(provider.id);
        const modelsHtml = renderModelList(providerModels, state.enabledModels);
        return renderProviderCollapsible(provider, modelsHtml);
      })
      .join('');

    providersList.innerHTML = html;
  }
}
