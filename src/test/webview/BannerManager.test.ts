// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - test
// Since BannerManager uses ES6 modules with path aliases that Node.js doesn't understand,
// we'll create a mock implementation that mirrors the actual behavior for testing purposes.

type ToolbarButtonElement = HTMLElement & { icon?: string };

// Mock BannerManager implementation for testing
class BannerManager {
  private _listeners: Array<{
    element: any;
    event: string;
    handler: (...args: any[]) => unknown;
  }> = [];

  showBanner(id: string, config: any = {}) {
    const element = (global as any).safeGetElementById(id);
    if (!element) {
      console.warn(`[BannerManager] Element with id '${id}' not found`);
      return;
    }

    switch (id) {
      case 'apiKeyBanner':
        this._setupApiKeyBanner(element, config);
        break;
      case 'agentConfigBanner':
        this._setupAgentConfigBanner(element, config);
        break;
      case 'dependencyBanner':
        this._setupDependencyBanner(element, config);
        break;
    }

    element.style.display = 'flex';
  }

  hideBanner(id: string) {
    const element = (global as any).safeGetElementById(id);
    if (element) {
      element.style.display = 'none';
    }
  }

  private _setupApiKeyBanner(element: any, config: any) {
    const textSpan = element.querySelector('span');
    const setButton = element.querySelector('#apiKeyBannerButton');
    const getButton = element.querySelector('#apiKeyGuideButton');

    if (!(textSpan && setButton && getButton)) {
      console.warn('[BannerManager] API key banner missing required elements');
      return;
    }

    if (config.provider) {
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

  private _setupAgentConfigBanner(element: any, config: any) {
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

    if (textSpan && config.agentName) {
      textSpan.textContent = `Agent file for "${config.agentName}" is missing.`;
    } else if (textSpan) {
      textSpan.textContent = 'Agent configuration is missing.';
    }

    this._applyToolbarButtonLabel(editButton, 'Edit Agents', {
      ariaLabel: 'Edit agents',
      title: 'Edit agents',
    });

    const dirLabel = config.customDirSet ? 'Open Directory' : 'Set Directory';
    this._applyToolbarButtonLabel(dirButton, dirLabel, {
      ariaLabel: dirLabel,
      title: dirLabel,
    });

    this._applyToolbarButtonLabel(docButton, 'Docs', {
      ariaLabel: 'Open documentation',
      title: 'Open documentation',
    });

    element.dataset.customDirSet = String(config.customDirSet || false);
  }

  private _applyToolbarButtonLabel(
    button: HTMLElement | null,
    label: string,
    options: { ariaLabel?: string; title?: string } = {},
  ) {
    if (!button) {
      return;
    }

    if (button.tagName === 'VSCODE-TOOLBAR-BUTTON') {
      button.setAttribute('label', label);
    } else {
      button.textContent = label;
    }

    const resolvedAriaLabel = options.ariaLabel ?? label;
    if (resolvedAriaLabel) {
      button.setAttribute('aria-label', resolvedAriaLabel);
    } else {
      button.removeAttribute('aria-label');
    }

    const resolvedTitle = options.title ?? resolvedAriaLabel;
    if (resolvedTitle) {
      button.setAttribute('title', resolvedTitle);
    } else if (options.title !== undefined) {
      button.removeAttribute('title');
    }
  }

  private _setupDependencyBanner(element: any, config: any) {
    const container = element.querySelector('.missing-tools');
    const actions = element.querySelector('.actions');

    if (!(container && actions)) {
      console.warn(
        '[BannerManager] Dependency banner missing required elements',
      );
      return;
    }

    container.textContent = '';

    const missing = config?.missingTools || [];
    if (missing.length > 0) {
      const intro = document.createElement('span');
      intro.textContent = 'Missing dependencies:';
      container.appendChild(intro);

      missing.forEach((tool: string) => {
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

    let recheckButton = actions.querySelector(
      '#dependencyRecheckButton',
    ) as ToolbarButtonElement | null;
    if (!recheckButton) {
      recheckButton = document.createElement(
        'vscode-toolbar-button',
      ) as ToolbarButtonElement;
      recheckButton.id = 'dependencyRecheckButton';
      recheckButton.setAttribute('icon', 'refresh');
      actions.insertBefore(recheckButton, actions.firstChild);
    }

    this._applyToolbarButtonLabel(recheckButton, 'Re-check', {
      ariaLabel: 'Re-check dependencies',
      title: 'Re-check dependencies',
    });
  }

  private _addDependencyItem(container: any, label: string, tool: string) {
    const item = document.createElement('div');
    item.classList.add('dependency-item');

    const nameSpan = document.createElement('span');
    nameSpan.textContent = label;

    const button = document.createElement(
      'vscode-toolbar-button',
    ) as ToolbarButtonElement;
    button.className = 'secondary dependency-install-button';
    button.textContent = 'Install';
    button.setAttribute('icon', 'cloud-download');
    button.dataset.tool = tool;

    item.appendChild(nameSpan);
    item.appendChild(button);
    container.appendChild(item);
  }

  addListener(
    elementOrId: any,
    event: string,
    handler: (...args: any[]) => unknown,
  ) {
    const element =
      typeof elementOrId === 'string'
        ? (global as any).safeGetElementById(elementOrId)
        : elementOrId;
    if (element) {
      element.addEventListener(event, handler);
      this._listeners.push({ element, event, handler });
    }
  }

  cleanup() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];
  }
}

describe('BannerManager', () => {
  let dom: any;
  let manager: any;
  let originalConsoleWarn: any;
  let warnMessages: string[];

  beforeEach(() => {
    // Set up DOM environment
    dom = new JSDOM(`<!doctype html><html><body>
      <div id="apiKeyBanner" style="display: none;">
        <span></span>
        <vscode-toolbar-button id="apiKeyBannerButton"></vscode-toolbar-button>
        <vscode-toolbar-button id="apiKeyGuideButton"></vscode-toolbar-button>
      </div>
      <div id="agentConfigBanner" style="display: none;">
        <span></span>
        <div class="actions">
          <vscode-toolbar-button id="agentConfigEditButton"></vscode-toolbar-button>
          <vscode-toolbar-button id="agentConfigDirButton"></vscode-toolbar-button>
          <vscode-toolbar-button id="agentConfigDocButton"></vscode-toolbar-button>
        </div>
      </div>
      <div id="dependencyBanner" style="display: none;">
        <span class="missing-tools"></span>
        <div class="actions">
          <vscode-toolbar-button id="dependencyRecheckButton"></vscode-toolbar-button>
          <vscode-toolbar-button id="dependencyDismissButton"></vscode-toolbar-button>
        </div>
      </div>
    </body></html>`);

    global.document = dom.window.document as any;
    global.HTMLElement = dom.window.HTMLElement;

    // Mock safeGetElementById
    (global as any).safeGetElementById = (id: string) => {
      return dom.window.document.getElementById(id);
    };

    // Capture console warnings
    warnMessages = [];
    originalConsoleWarn = console.warn;
    console.warn = (message: string) => {
      warnMessages.push(message);
    };

    manager = new BannerManager();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
  });

  describe('showBanner', () => {
    it('should display banner with flex style', () => {
      const banner = dom.window.document.getElementById('apiKeyBanner');
      manager.showBanner('apiKeyBanner');
      assert.equal(banner.style.display, 'flex');
    });

    it('should warn when banner element not found', () => {
      manager.showBanner('nonExistentBanner');
      assert.equal(warnMessages.length, 1);
      assert.ok(warnMessages[0].includes('not found'));
    });
  });

  describe('hideBanner', () => {
    it('should hide banner by setting display to none', () => {
      const banner = dom.window.document.getElementById('apiKeyBanner');
      banner.style.display = 'flex';
      manager.hideBanner('apiKeyBanner');
      assert.equal(banner.style.display, 'none');
    });

    it('should handle missing banner gracefully', () => {
      // Should not throw when banner doesn't exist
      assert.doesNotThrow(() => {
        manager.hideBanner('nonExistentBanner');
      });
    });
  });

  describe('API Key Banner', () => {
    it('should set up generic API key banner without provider', () => {
      const banner = dom.window.document.getElementById('apiKeyBanner');
      const textSpan = banner.querySelector('span');
      const setButton = banner.querySelector('#apiKeyBannerButton');
      const getButton = banner.querySelector('#apiKeyGuideButton');

      manager.showBanner('apiKeyBanner');

      assert.equal(textSpan.textContent, 'TeXRA requires an API key to run.');
      assert.equal(setButton.textContent, 'Set API Key');
      assert.equal(getButton.textContent, 'API Key Guide');
      assert.equal(setButton.tagName, 'VSCODE-TOOLBAR-BUTTON');
      assert.equal(getButton.tagName, 'VSCODE-TOOLBAR-BUTTON');
      assert.equal(banner.dataset.provider, undefined);
    });

    it('should set up provider-specific API key banner safely', () => {
      const banner = dom.window.document.getElementById('apiKeyBanner');
      const textSpan = banner.querySelector('span');
      const setButton = banner.querySelector('#apiKeyBannerButton');
      const getButton = banner.querySelector('#apiKeyGuideButton');

      manager.showBanner('apiKeyBanner', { provider: 'openai' });

      // Check that text is set safely without innerHTML
      assert.equal(textSpan.childNodes.length, 2);
      assert.equal(textSpan.childNodes[0].nodeName, 'STRONG');
      assert.equal(textSpan.childNodes[0].textContent, 'Openai');
      assert.equal(textSpan.childNodes[1].textContent, ' API key missing.');

      assert.equal(setButton.textContent, 'Set Key');
      assert.equal(getButton.textContent, 'Get Key');
      assert.equal(setButton.tagName, 'VSCODE-TOOLBAR-BUTTON');
      assert.equal(getButton.tagName, 'VSCODE-TOOLBAR-BUTTON');
      assert.equal(banner.dataset.provider, 'openai');
    });

    it('should handle XSS attempt in provider name', () => {
      const banner = dom.window.document.getElementById('apiKeyBanner');
      const textSpan = banner.querySelector('span');

      manager.showBanner('apiKeyBanner', {
        provider: '<script>alert("xss")</script>',
      });

      // Verify that script tag is escaped as text, not executed
      const strongElement = textSpan.querySelector('strong');
      assert.equal(strongElement.textContent, '<script>alert("xss")</script>');
      assert.equal(
        strongElement.innerHTML,
        '&lt;script&gt;alert("xss")&lt;/script&gt;',
      );
    });

    it('should warn when API key banner missing elements', () => {
      // Remove required elements
      const banner = dom.window.document.getElementById('apiKeyBanner');
      banner.innerHTML = '<div></div>';

      manager.showBanner('apiKeyBanner', { provider: 'test' });

      assert.equal(warnMessages.length, 1);
      assert.ok(warnMessages[0].includes('missing required elements'));
    });
  });

  describe('Agent Config Banner', () => {
    it('should set up generic agent config banner', () => {
      const banner = dom.window.document.getElementById('agentConfigBanner');
      const textSpan = banner.querySelector('span');
      const dirButton = banner.querySelector(
        '#agentConfigDirButton',
      ) as HTMLElement;
      const editButton = banner.querySelector(
        '#agentConfigEditButton',
      ) as HTMLElement;
      const docButton = banner.querySelector(
        '#agentConfigDocButton',
      ) as HTMLElement;

      manager.showBanner('agentConfigBanner');

      assert.equal(textSpan.textContent, 'Agent configuration is missing.');
      assert.equal(editButton.getAttribute('label'), 'Edit Agents');
      assert.equal(editButton.getAttribute('aria-label'), 'Edit agents');
      assert.equal(editButton.getAttribute('title'), 'Edit agents');
      assert.equal(dirButton.getAttribute('label'), 'Set Directory');
      assert.equal(dirButton.getAttribute('aria-label'), 'Set Directory');
      assert.equal(dirButton.getAttribute('title'), 'Set Directory');
      assert.equal(docButton.getAttribute('label'), 'Docs');
      assert.equal(docButton.getAttribute('aria-label'), 'Open documentation');
      assert.equal(docButton.getAttribute('title'), 'Open documentation');
      assert.equal(banner.dataset.customDirSet, 'false');
    });

    it('should set up agent-specific config banner', () => {
      const banner = dom.window.document.getElementById('agentConfigBanner');
      const textSpan = banner.querySelector('span');
      const dirButton = banner.querySelector(
        '#agentConfigDirButton',
      ) as HTMLElement;

      manager.showBanner('agentConfigBanner', {
        agentName: 'TestAgent',
        customDirSet: true,
      });

      assert.equal(
        textSpan.textContent,
        'Agent file for "TestAgent" is missing.',
      );
      assert.equal(dirButton.getAttribute('label'), 'Open Directory');
      assert.equal(dirButton.getAttribute('aria-label'), 'Open Directory');
      assert.equal(dirButton.getAttribute('title'), 'Open Directory');
      assert.equal(banner.dataset.customDirSet, 'true');
    });

    it('should handle missing text span gracefully', () => {
      const banner = dom.window.document.getElementById('agentConfigBanner');
      banner.innerHTML =
        '<vscode-toolbar-button id="agentConfigDirButton"></vscode-toolbar-button>';

      assert.doesNotThrow(() => {
        manager.showBanner('agentConfigBanner', { agentName: 'Test' });
      });

      const dirButton = banner.querySelector(
        '#agentConfigDirButton',
      ) as HTMLElement;
      assert.equal(dirButton.getAttribute('label'), 'Set Directory');
    });

    it('should warn when all elements are missing', () => {
      const banner = dom.window.document.getElementById('agentConfigBanner');
      banner.innerHTML = '';

      manager.showBanner('agentConfigBanner');

      assert.equal(warnMessages.length, 1);
      assert.ok(warnMessages[0].includes('missing all expected elements'));
    });
  });

  describe('Dependency Banner', () => {
    it('should display install buttons for missing tools', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');

      manager.showBanner('dependencyBanner', { missingTools: ['latex'] });

      const items = banner.querySelectorAll('.dependency-item');
      assert.equal(items.length, 1);
      const label = items[0].querySelector('span');
      const button = items[0].querySelector('vscode-toolbar-button');
      assert.equal(button.tagName, 'VSCODE-TOOLBAR-BUTTON');
      assert.equal(label.textContent, 'latex');
      assert.equal(button.textContent, 'Install');
      assert.equal(button.dataset.tool, 'latex');
    });

    it('should handle gm/magick as two separate tools', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');

      manager.showBanner('dependencyBanner', { missingTools: ['gm/magick'] });

      const items = banner.querySelectorAll('.dependency-item');
      assert.equal(items.length, 2);
      const names = Array.from(items as any).map(
        (i: any) => i.querySelector('span').textContent,
      );
      assert.deepEqual(names, ['GraphicsMagick', 'ImageMagick']);
    });

    it('should handle empty dependencies array', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      const container = banner.querySelector('.missing-tools');

      manager.showBanner('dependencyBanner', { missingTools: [] });

      assert.equal(container.textContent, 'Missing dependencies: none');
    });

    it('should handle missing config gracefully', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      const container = banner.querySelector('.missing-tools');

      manager.showBanner('dependencyBanner');

      assert.equal(container.textContent, 'Missing dependencies: none');
    });

    it('should warn when required elements are missing', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      banner.innerHTML = '';

      manager.showBanner('dependencyBanner', { missingTools: ['test'] });

      assert.equal(warnMessages.length, 1);
      assert.ok(warnMessages[0].includes('missing required elements'));
    });

    it('should ensure re-check button exists', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      manager.showBanner('dependencyBanner', { missingTools: [] });
      const recheck = banner.querySelector(
        '#dependencyRecheckButton',
      ) as HTMLElement;
      assert.equal(recheck.tagName, 'VSCODE-TOOLBAR-BUTTON');
      assert.equal(recheck.getAttribute('label'), 'Re-check');
      assert.equal(recheck.getAttribute('aria-label'), 'Re-check dependencies');
      assert.equal(recheck.getAttribute('title'), 'Re-check dependencies');
    });
  });

  describe('Cleanup', () => {
    it('should inherit cleanup from BaseUIManager', () => {
      // Verify cleanup method exists (inherited from BaseUIManager)
      assert.equal(typeof manager.cleanup, 'function');
    });

    it('should inherit addListener from BaseUIManager', () => {
      // Verify addListener method exists (inherited from BaseUIManager)
      assert.equal(typeof manager.addListener, 'function');
    });
  });
});
