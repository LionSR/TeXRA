// Local imports - webview
import { safeGetElementById } from '@common/domUtils.js';
import { ELEMENT_IDS } from '../constants.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';

/**
 * Manages display and configuration of notification banners.
 */
export class BannerManager extends BaseDomHandler {
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
      case ELEMENT_IDS.GETTING_STARTED_BANNER:
        this._setupGettingStartedBanner(element);
        break;
      case ELEMENT_IDS.LOGIN_BANNER:
        this._setupLoginBanner(element, config);
        break;
      default:
        break;
    }

    // Getting started banner uses block layout; others use flex for button alignment
    const displayStyle =
      id === ELEMENT_IDS.GETTING_STARTED_BANNER ? 'block' : 'flex';
    element.style.setProperty('display', displayStyle);
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
    const editButton = element.querySelector('#agentConfigEditButton');
    const dirButton = element.querySelector('#agentConfigDirButton');
    const docButton = element.querySelector('#agentConfigDocButton');

    if (!(textSpan || editButton || dirButton || docButton)) {
      console.warn(
        '[BannerManager] Agent config banner missing all expected elements',
      );
      return;
    }

    if (textSpan) {
      textSpan.textContent = config?.agentName
        ? `Agent file for "${config.agentName}" is missing.`
        : 'Agent configuration is missing.';
    }

    this._applyToolbarButtonLabel(editButton, 'Edit Agents', {
      ariaLabel: 'Edit agents',
      title: 'Edit agents',
    });

    const dirLabel = config?.customDirSet ? 'Open Directory' : 'Set Directory';
    this._applyToolbarButtonLabel(dirButton, dirLabel, {
      ariaLabel: dirLabel,
      title: dirLabel,
    });

    this._applyToolbarButtonLabel(docButton, 'Docs', {
      ariaLabel: 'Open documentation',
      title: 'Open documentation',
    });

    element.dataset.customDirSet = config?.customDirSet ? 'true' : 'false';
  }

  /**
   * Apply toolbar button labels and accessibility attributes.
   * @private
   * @param {HTMLElement | null} button - Button element to update
   * @param {string} label - Visible label text
   * @param {object} [options] - Additional configuration options
   * @param {string} [options.ariaLabel] - Accessible label override
   * @param {string} [options.title] - Tooltip/title override
   */
  _applyToolbarButtonLabel(button, label, options = {}) {
    if (!button) {
      return;
    }

    const { ariaLabel, title } = options;

    if (button.tagName === 'VSCODE-TOOLBAR-BUTTON') {
      button.setAttribute('label', label);
    } else {
      button.textContent = label;
    }

    const resolvedAriaLabel = ariaLabel ?? label;
    if (resolvedAriaLabel) {
      button.setAttribute('aria-label', resolvedAriaLabel);
    } else {
      button.removeAttribute('aria-label');
    }

    const resolvedTitle = title ?? resolvedAriaLabel;
    if (resolvedTitle) {
      button.setAttribute('title', resolvedTitle);
    } else if (title !== undefined) {
      button.removeAttribute('title');
    }
  }

  /**
   * Configure dependency banner with missing tools.
   * @private
   * @param {HTMLElement} element - The banner element
   * @param {object} config - Configuration object
   * @param {string[]} [config.missingTools] - Array of missing tool names
   */
  _setupDependencyBanner(element, config) {
    const container = element.querySelector('.missing-tools');
    const actions = element.querySelector('.actions');

    if (!(container && actions)) {
      console.warn(
        '[BannerManager] Dependency banner missing required elements',
      );
      return;
    }

    // Clear existing content
    container.textContent = '';

    const missing = config?.missingTools ?? [];
    if (missing.length > 0) {
      const intro = document.createElement('span');
      intro.textContent = 'Missing dependencies:';
      container.appendChild(intro);

      missing.forEach((tool) => {
        if (tool === 'gm/magick') {
          this._addDependencyItem(container, 'GraphicsMagick', 'gm');
          this._addDependencyItem(container, 'ImageMagick', 'magick');
        } else {
          this._addDependencyItem(container, tool, tool);
        }
      });
    } else {
      container.textContent = 'Missing dependencies: none';
    }

    // Ensure re-check button exists
    let recheckButton = actions.querySelector('#dependencyRecheckButton');
    if (!recheckButton) {
      recheckButton = document.createElement('vscode-toolbar-button');
      recheckButton.id = 'dependencyRecheckButton';
      recheckButton.setAttribute('icon', 'refresh');
      actions.insertBefore(recheckButton, actions.firstChild);
    }

    this._applyToolbarButtonLabel(recheckButton, 'Re-check', {
      ariaLabel: 'Re-check dependencies',
      title: 'Re-check dependencies',
    });
  }

  /**
   * Add a dependency item with install button to the container.
   * @private
   * @param {HTMLElement} container - container for dependency items
   * @param {string} label - Display name of the tool
   * @param {string} tool - Tool identifier for install command
   */
  _addDependencyItem(container, label, tool) {
    const item = document.createElement('div');
    item.classList.add('dependency-item');

    const nameSpan = document.createElement('span');
    nameSpan.textContent = label;

    const button = document.createElement('vscode-toolbar-button');
    button.className = 'btn-secondary dependency-install-button';
    button.textContent = 'Install';
    button.setAttribute('icon', 'cloud-download');
    button.dataset.tool = tool;

    item.appendChild(nameSpan);
    item.appendChild(button);
    container.appendChild(item);
  }

  /**
   * Configure getting started banner with helpful links.
   * @private
   * @param {HTMLElement} element - The banner element
   */
  _setupGettingStartedBanner(element) {
    const textContainer = element.querySelector('.getting-started-text');
    if (!textContainer) {
      console.warn(
        '[BannerManager] Getting started banner missing text container',
      );
      return;
    }

    // Clear existing content safely
    textContainer.replaceChildren();

    // Build the message with command links
    const introText = document.createTextNode(
      'No files found in workspace. Try ',
    );
    textContainer.appendChild(introText);

    // Create links
    const links = [
      {
        command: 'texra.openGettingStarted',
        text: 'opening the getting started walkthrough',
      },
      {
        command: 'texra.createSampleProject',
        text: 'creating a sample project',
      },
      {
        command: 'texra.cloneOverleafProject',
        text: 'cloning an Overleaf project',
      },
      {
        command: 'texra.downloadArXivSource',
        text: 'downloading an arXiv source',
      },
    ];

    links.forEach((link, index) => {
      const anchor = document.createElement('a');
      anchor.href = `command:${link.command}`;
      anchor.textContent = link.text;
      textContainer.appendChild(anchor);

      if (index < links.length - 1) {
        const separator =
          index === links.length - 2
            ? document.createTextNode(', or ')
            : document.createTextNode(', ');
        textContainer.appendChild(separator);
      }
    });

    textContainer.appendChild(document.createTextNode('.'));
  }

  /**
   * Configure login banner.
   * @private
   * @param {HTMLElement} element - The banner element
   * @param {object} config - Configuration object
   * @param {string} [config.title] - Optional custom title
   * @param {string} [config.description] - Optional custom description
   */
  _setupLoginBanner(element, config) {
    const titleElement = element.querySelector('.login-banner-title');
    const descriptionElement = element.querySelector(
      '.login-banner-description',
    );

    if (!(titleElement && descriptionElement)) {
      console.warn(
        '[BannerManager] Login banner missing title or description element',
      );
      return;
    }

    if (config?.title) {
      titleElement.textContent = config.title;
    }

    if (config?.description) {
      descriptionElement.textContent = config.description;
    }
  }
}

export const bannerManager = new BannerManager();
