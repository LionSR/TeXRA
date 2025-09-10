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

  /**
   * Configure API key banner with provider-specific content.
   * @private
   * @param {HTMLElement} element - The banner element
   * @param {object} config - Configuration object
   * @param {string} [config.provider] - API provider name
   */
  _setupApiKeyBanner(element, config) {
    const textSpan = element.querySelector('span');
    const setButton = element.querySelector('#apiKeyBannerButton');
    const getButton = element.querySelector('#apiKeyGuideButton');
    
    if (!(textSpan && setButton && getButton)) {
      console.warn('[BannerManager] API key banner missing required elements');
      return;
    }

    if (config?.provider) {
      const providerName =
        config.provider.charAt(0).toUpperCase() + config.provider.slice(1);
      
      // Clear existing content and use safe DOM manipulation
      textSpan.textContent = '';
      
      // Create strong element for provider name
      const strongElement = document.createElement('strong');
      strongElement.textContent = providerName;
      
      // Append elements safely
      textSpan.appendChild(strongElement);
      textSpan.appendChild(document.createTextNode(' API key missing.'));
      
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

  /**
   * Configure agent configuration banner.
   * @private
   * @param {HTMLElement} element - The banner element
   * @param {object} config - Configuration object
   * @param {string} [config.agentName] - Name of the missing agent
   * @param {boolean} [config.customDirSet] - Whether custom directory is set
   */
  _setupAgentConfigBanner(element, config) {
    const textSpan = element.querySelector('span');
    const dirButton = element.querySelector('#agentConfigDirButton');
    
    if (!textSpan && !dirButton) {
      console.warn('[BannerManager] Agent config banner missing all expected elements');
      return;
    }
    
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

  /**
   * Configure dependency banner with missing tools.
   * @private
   * @param {HTMLElement} element - The banner element
   * @param {object} config - Configuration object
   * @param {string[]} [config.missingTools] - Array of missing tool names
   */
  _setupDependencyBanner(element, config) {
    const textSpan = element.querySelector('span');
    
    if (!textSpan) {
      console.warn('[BannerManager] Dependency banner missing text element');
      return;
    }
    
    const missing = config?.missingTools || [];
    const formatted = missing.map((tool) =>
      tool === 'gm/magick' ? 'GraphicsMagick or ImageMagick' : tool,
    );
    
    if (formatted.length > 0) {
      textSpan.textContent = `Missing dependencies: ${formatted.join(', ')}`;
    } else {
      textSpan.textContent = 'Missing dependencies: none';
    }
  }
}

export const bannerManager = new BannerManager();
