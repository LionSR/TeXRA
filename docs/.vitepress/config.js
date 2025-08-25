// .vitepress/config.js
import { withMermaid } from 'vitepress-plugin-mermaid';

// Define the base VitePress config
const baseConfig = {
  title: 'TeXRA',
  description: 'Your Intelligent Academic Research Assistant',
  head: [
    ['link', { rel: 'icon', href: '/logo-128x128.svg' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: '/assets/fonts/codicon/codicon.css',
      },
    ],
    [
      'script',
      {},
      `
      // Execute when DOM is fully loaded
      document.addEventListener('DOMContentLoaded', function() {
        // Try to prevent scroll restoration
        if ('scrollRestoration' in history) {
          history.scrollRestoration = 'manual';
        }

        // Wait a bit to ensure the PDF tabs are ready
        setTimeout(function() {
          // PDF tab switcher - more robust implementation
          function initPdfTabs() {
            const pdfTabs = document.querySelectorAll('.pdf-tab');
            const pdfFrame = document.getElementById('pdf-frame');
            const pdfLink = document.getElementById('pdf-link');
            
            if (!pdfTabs.length || !pdfFrame || !pdfLink) return;
            
            pdfTabs.forEach(tab => {
              // Remove any existing click listeners first
              tab.replaceWith(tab.cloneNode(true));
            });
            
            // Re-select tabs after cloning
            const newTabs = document.querySelectorAll('.pdf-tab');
            newTabs.forEach(tab => {
              tab.addEventListener('click', function(e) {
                // Prevent any default behavior
                e.preventDefault();
                e.stopPropagation();
                
                // Store current scroll position
                const scrollPos = window.scrollY || document.documentElement.scrollTop;
                
                const pdfPath = this.getAttribute('data-pdf');
                if (!pdfPath) return;
                
                // Update iframe source
                pdfFrame.src = pdfPath;
                // Update "Open in new tab" link
                pdfLink.href = pdfPath;
                
                // Update active tab
                newTabs.forEach(t => t.classList.remove('active'));
                this.classList.add('active');
                
                // Restore scroll position
                setTimeout(() => {
                  window.scrollTo(0, scrollPos);
                }, 0);
                
                // Debugging
                console.log('Tab clicked:', pdfPath);
                return false;
              });
            });
          }
          
          // Initial setup
          initPdfTabs();
          
          // Also initialize after a slight delay to handle any page reflows
          setTimeout(initPdfTabs, 1000);
          
          // For single-page applications, re-init on URL changes
          if (window.addEventListener) {
            let lastUrl = location.href;
            new MutationObserver(() => {
              const url = location.href;
              if (url !== lastUrl) {
                lastUrl = url;
                setTimeout(initPdfTabs, 500);
              }
            }).observe(document, {subtree: true, childList: true});
          }
        }, 200);
      });
      `,
    ],
  ],
  themeConfig: {
    logo: '/logo-128x128.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/' },
      { text: 'Launch', link: '/launch' },
      { text: 'Reference', link: '/reference/' },
      { text: 'GitHub', link: 'https://github.com/texra-ai/texra-issues' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            {
              text: 'LaTeX Compilation Setup',
              link: '/guide/latex-compilation.md',
            },
            {
              text: 'Acknowledgments & Inspirations',
              link: '/guide/acknowledgments.md',
            },
          ],
        },
        {
          text: 'Core Concepts',
          items: [
            {
              text: 'Agent Architecture',
              link: '/guide/agent-architecture.md',
            },
            { text: 'Built-in Agents', link: '/guide/built-in-agents.md' },
            { text: 'Models', link: '/guide/models' },
            { text: 'File Management', link: '/guide/file-management' },
            {
              text: 'Working with Figures',
              link: '/guide/working-with-figures.md',
            },
            { text: 'ProgressBoard', link: '/guide/progress-board' },
            { text: 'Tool Integration', link: '/guide/tool-integration' },
          ],
        },
        {
          text: 'Advanced Usage',
          items: [
            { text: 'TikZ Figures', link: '/guide/tikz-figures' },
            { text: 'LaTeX Diff', link: '/guide/latex-diff' },
            { text: 'Intelligent Merge', link: '/guide/intelligent-merge' },
            { text: 'Multiple Output', link: '/guide/multiple-output' },
          ],
        },
        {
          text: 'Customization',
          items: [
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Agent Explorer', link: '/guide/agent-explorer' },
            { text: 'Custom Agents', link: '/guide/custom-agents' },
          ],
        },
        {
          text: 'Best Practices',
          items: [
            { text: 'General Workflow', link: '/guide/best-practices.md' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Resources',
          items: [
            { text: 'Troubleshooting', link: '/reference/troubleshooting' },
            { text: 'Glossary', link: '/reference/glossary' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/texra-ai' }],
    search: {
      provider: 'local',
    },
    footer: {
      copyright: 'Copyright © 2024-present TeXRA Team. All rights reserved.',
    },
  },
  ignoreDeadLinks: true,
};

// Export the config wrapped with withMermaid, including optional configs
export default withMermaid(baseConfig, {
  // your existing vitepress config is passed above as baseConfig
  // optionally, you can pass MermaidConfig
  mermaid: {
    // refer https://mermaid.js.org/config/setup/modules/mermaidAPI.html#mermaidapi-configuration-defaults for options
    // Add any specific Mermaid options here, e.g.:
    // theme: 'dark',
  },
  // optionally set additional config for plugin itself with MermaidPluginConfig
  mermaidPlugin: {
    class: 'mermaid', // Default class, you can add more like "my-class"
  },
});
