// Local imports - webview
import { safeGetElementById } from '@common/domUtils.js';
import { ELEMENT_IDS } from '../constants.js';
import { BaseUIManager } from './BaseUIManager.js';

/**
 * Manages display and configuration of notification banners.
 */
export class BannerManager extends BaseUIManager {
  /**
   * Show a banner by element id.
   * @param {string} id - DOM element id of banner
   * @param {object} [config] - optional config for banner content
   */
  showBanner(id, config = {}) {
    const element = safeGetElementById(id);
    if (!element) {
      console.warn(`[BannerManager] Element with id '${id}' not found`);
      return;
    }

    switch (id) {
      case ELEMENT_IDS.API_KEY_BANNER:
        this._setupApiKeyBanner(element, config);
        break;
      case ELEMENT_IDS.AGENT_CONFIG_BANNER:
        this._setupAgentConfigBanner(element, config);
        break;
      case ELEMENT_IDS.DEPENDENCY_BANNER:
        this._setupDependencyBanner(element, config);
        break;
      default:
        break;
    }

    element.style.setProperty('display', 'flex');
  }

  /**
   * Hide a banner by element id.
   * @param {string} id - DOM element id of banner
   */
  hideBanner(id) {
    const element = safeGetElementById(id);
    if (element) {
      element.style.setProperty('display', 'none');
    }
  }

  _setupApiKeyBanner(element, config) {
    const textSpan = element.querySelector('span');
    const setButton = element.querySelector('#apiKeyBannerButton');
    const getButton = element.querySelector('#apiKeyGuideButton');
    if (!(textSpan && setButton && getButton)) return;

    if (config?.provider) {
      const providerName =
        config.provider.charAt(0).toUpperCase() + config.provider.slice(1);
      textSpan.innerHTML = `<strong>${providerName}</strong> API key missing.`;
      setButton.textContent = 'Set Key';
      getButton.textContent = 'Get Key';
      element.dataset.provider = config.provider;
    } else {
      textSpan.textContent = 'TeXRA requires an API key to run.';
      setButton.textContent = 'Set API Key';
      getButton.textContent = 'API Key Guide';
      delete element.dataset.provider;
    }
  }

  _setupAgentConfigBanner(element, config) {
    const textSpan = element.querySelector('span');
    const dirButton = element.querySelector('#agentConfigDirButton');
    if (textSpan) {
      textSpan.textContent = config?.agentName
        ? `Agent file for "${config.agentName}" is missing.`
        : 'Agent configuration is missing.';
    }
    if (dirButton) {
      dirButton.textContent = config?.customDirSet
        ? 'Open Directory'
        : 'Set Directory';
    }
    element.dataset.customDirSet = config?.customDirSet ? 'true' : 'false';
  }

  _setupDependencyBanner(element, config) {
    const textSpan = element.querySelector('span');
    if (!textSpan) return;
    const missing = config?.missingTools || [];
    const formatted = missing.map((tool) =>
      tool === 'gm/magick' ? 'GraphicsMagick or ImageMagick' : tool,
    );
    if (formatted.length > 0) {
      textSpan.textContent = `Missing dependencies: ${formatted.join(', ')}`;
    }
  }
}

export const bannerManager = new BannerManager();
