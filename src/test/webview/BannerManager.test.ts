// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - test
// @ts-ignore: BannerManager is compiled JS module
import { BannerManager } from '../../webview/modules/uiManagers/BannerManager.js';

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
        <button id="apiKeyBannerButton"></button>
        <button id="apiKeyGuideButton"></button>
      </div>
      <div id="agentConfigBanner" style="display: none;">
        <span></span>
        <button id="agentConfigDirButton"></button>
      </div>
      <div id="dependencyBanner" style="display: none;">
        <span></span>
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
      assert.equal(banner.dataset.provider, 'openai');
    });

    it('should handle XSS attempt in provider name', () => {
      const banner = dom.window.document.getElementById('apiKeyBanner');
      const textSpan = banner.querySelector('span');
      
      manager.showBanner('apiKeyBanner', { 
        provider: '<script>alert("xss")</script>' 
      });
      
      // Verify that script tag is escaped as text, not executed
      const strongElement = textSpan.querySelector('strong');
      assert.equal(strongElement.textContent, '<script>alert("xss")</script>');
      assert.equal(strongElement.innerHTML, '&lt;script&gt;alert("xss")&lt;/script&gt;');
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
      const dirButton = banner.querySelector('#agentConfigDirButton');
      
      manager.showBanner('agentConfigBanner');
      
      assert.equal(textSpan.textContent, 'Agent configuration is missing.');
      assert.equal(dirButton.textContent, 'Set Directory');
      assert.equal(banner.dataset.customDirSet, 'false');
    });

    it('should set up agent-specific config banner', () => {
      const banner = dom.window.document.getElementById('agentConfigBanner');
      const textSpan = banner.querySelector('span');
      const dirButton = banner.querySelector('#agentConfigDirButton');
      
      manager.showBanner('agentConfigBanner', {
        agentName: 'TestAgent',
        customDirSet: true
      });
      
      assert.equal(textSpan.textContent, 'Agent file for "TestAgent" is missing.');
      assert.equal(dirButton.textContent, 'Open Directory');
      assert.equal(banner.dataset.customDirSet, 'true');
    });

    it('should handle missing text span gracefully', () => {
      const banner = dom.window.document.getElementById('agentConfigBanner');
      banner.innerHTML = '<button id="agentConfigDirButton"></button>';
      
      assert.doesNotThrow(() => {
        manager.showBanner('agentConfigBanner', { agentName: 'Test' });
      });
      
      const dirButton = banner.querySelector('#agentConfigDirButton');
      assert.equal(dirButton.textContent, 'Set Directory');
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
    it('should display missing dependencies', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      const textSpan = banner.querySelector('span');
      
      manager.showBanner('dependencyBanner', {
        missingTools: ['latex', 'gm/magick', 'nodejs']
      });
      
      assert.equal(
        textSpan.textContent,
        'Missing dependencies: latex, GraphicsMagick or ImageMagick, nodejs'
      );
    });

    it('should handle empty dependencies array', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      const textSpan = banner.querySelector('span');
      
      manager.showBanner('dependencyBanner', { missingTools: [] });
      
      assert.equal(textSpan.textContent, 'Missing dependencies: none');
    });

    it('should handle missing config gracefully', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      const textSpan = banner.querySelector('span');
      
      manager.showBanner('dependencyBanner');
      
      assert.equal(textSpan.textContent, 'Missing dependencies: none');
    });

    it('should warn when text span is missing', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      banner.innerHTML = '';
      
      manager.showBanner('dependencyBanner', {
        missingTools: ['test']
      });
      
      assert.equal(warnMessages.length, 1);
      assert.ok(warnMessages[0].includes('missing text element'));
    });

    it('should properly format gm/magick tool name', () => {
      const banner = dom.window.document.getElementById('dependencyBanner');
      const textSpan = banner.querySelector('span');
      
      manager.showBanner('dependencyBanner', {
        missingTools: ['gm/magick']
      });
      
      assert.equal(
        textSpan.textContent,
        'Missing dependencies: GraphicsMagick or ImageMagick'
      );
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