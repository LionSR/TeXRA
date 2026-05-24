// .vitepress/config.js
import { withMermaid } from 'vitepress-plugin-mermaid';

// Define the base VitePress config
// TEST DEPLOY: served at https://lionsr.github.io/TeXRA/. When we move to
// the texra.ai custom domain, set base back to '/' and re-add the CNAME
// step in .github/workflows/docs-deploy.yml.
const base = '/TeXRA/';

const baseConfig = {
  title: 'TeXRA',
  base,
  description:
    'Multi-agent AI system for scientific discovery. Specialized agents that polish LaTeX, search literature, generate figures, and build presentations — orchestrated in reproducible workflows inside VS Code.',
  head: [
    ['link', { rel: 'icon', href: `${base}logo-128x128.svg` }],
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

                return false;
              });
            });
          }

          // Initial setup
          initPdfTabs();

          // Also initialize after a slight delay to handle any page reflows
          setTimeout(initPdfTabs, 1000);

          // For single-page applications, re-init on URL changes
          let lastUrl = location.href;
          new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
              lastUrl = url;
              setTimeout(initPdfTabs, 500);
            }
          }).observe(document, {subtree: true, childList: true});
        }, 200);
      });
      `,
    ],
  ],
  themeConfig: {
    logo: '/logo-128x128.svg',
    nav: [
      { text: 'Home', link: '/' },
      {
        text: 'Docs',
        link: '/guide/',
        activeMatch: '/guide/(?!built-in-agents|agent-architecture)',
      },
      {
        text: 'Agents',
        link: '/guide/built-in-agents',
        activeMatch: '/guide/built-in-agents',
      },
      {
        text: 'Workflow',
        link: '/guide/agent-architecture',
        activeMatch: '/guide/agent-architecture',
      },
      { text: 'Launch', link: '/launch' },
      { text: 'GitHub', link: 'https://github.com/texra-ai/texra-issues' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Desktop App', link: '/guide/desktop' },
            {
              text: 'Desktop Migration',
              link: '/guide/desktop-migration',
            },
            { text: 'Quick Start', link: '/guide/quick-start' },
          ],
        },
        {
          text: 'Agent System',
          items: [
            { text: 'Built-in Agents', link: '/guide/built-in-agents.md' },
            {
              text: 'Workflow Agents',
              link: '/guide/agent-architecture.md',
            },
            { text: 'Custom Agents', link: '/guide/custom-agents' },
            { text: 'Remote Agents', link: '/guide/remote-agents' },
            { text: 'Models', link: '/guide/models' },
          ],
        },
        {
          text: 'Workflows',
          items: [
            { text: 'LaTeX Diff', link: '/guide/latex-diff' },
            { text: 'Intelligent Merge', link: '/guide/intelligent-merge' },
            { text: 'Research Tools', link: '/guide/research-tools' },
            { text: 'LaTeX Tools', link: '/guide/latex-tools' },
            {
              text: 'Working with Figures',
              link: '/guide/working-with-figures.md',
            },
            { text: 'TikZ Figures', link: '/guide/tikz-figures' },
            { text: 'Multiple Output', link: '/guide/multiple-output' },
          ],
        },
        {
          text: 'Integrations',
          items: [
            {
              text: 'Working with Overleaf',
              link: '/guide/working-with-overleaf',
            },
            { text: 'TeXRA CLI', link: '/guide/texra-cli' },
            { text: 'Codex CLI', link: '/guide/codex-cli' },
            { text: 'File Management', link: '/guide/file-management' },
            { text: 'ProgressBoard', link: '/guide/progress-board' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'LaTeX Compilation', link: '/guide/latex-compilation.md' },
            { text: 'Best Practices', link: '/guide/best-practices.md' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            { text: 'Acknowledgments', link: '/guide/acknowledgments.md' },
            { text: 'Open Source Projects', link: '/guide/open-source' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/texra-ai' }],
    search: {
      provider: 'local',
    },
    footer: {
      message:
        '<a href="/terms">Terms of Service</a> · <a href="/providers">Providers</a> · <a href="/guide/open-source">Open Source</a>',
      copyright: 'Copyright © 2024-2026 TeXRA Team. All rights reserved.',
    },
  },
  ignoreDeadLinks: true,
  // Public site allowlist: only index.md, launch.md, terms.md, providers.md,
  // and everything under guide/. Every other markdown file in this directory
  // is internal and must NOT be published to texra.ai. Static assets under
  // public/ are served as-is and are fine to expose.
  srcExclude: [
    'README.md',
    'analysis-subagent-updates.md',
    'desktop-signing-ci.md',
    'electron-migration-plan.md',
    'relay-tier-config.md',
    'blog/**',
    'design/**',
    'dev/**',
    'pocketflow/**',
    'prd/**',
    'proposals/**',
    'reference/**',
    'skills/**',
    'supabase/**',
    'toolCalls/**',
    'node_modules/**',
  ],
  vite: {
    vue: {
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith('wa-'),
        },
      },
    },
  },
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
