// .vitepress/config.js
import { withMermaid } from 'vitepress-plugin-mermaid';
import { srcExclude } from './publicDocs.js';

const base = '/';

const baseConfig = {
  title: 'TeXRA',
  base,
  description:
    'Multi-agent AI system for scientific discovery. Specialized agents that polish LaTeX, search literature, generate figures, and build presentations — orchestrated in reproducible workflows inside VS Code.',
  head: [
    ['link', { rel: 'icon', href: `${base}favicon.svg` }],
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
    logo: '/favicon.svg',
    nav: [
      {
        text: 'Docs',
        link: '/guide/',
        activeMatch: '/guide/(?!built-in-agents)',
      },
      {
        text: 'Agents',
        link: '/guide/built-in-agents',
        activeMatch: '/guide/built-in-agents',
      },
      { text: 'Launch', link: '/launch' },
      { text: 'Changelog', link: '/changelog', activeMatch: '/changelog' },
      { text: 'GitHub', link: 'https://github.com/texra-ai/texra-issues' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'First Run', link: '/guide/first-run' },
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
            { text: 'Memory', link: '/guide/memory' },
            { text: 'Models', link: '/guide/models' },
          ],
        },
        {
          text: 'Workflows',
          items: [
            { text: 'Polish a Draft', link: '/guide/workflows/polish-a-draft' },
            { text: 'LaTeX Diff', link: '/guide/latex-diff' },
            { text: 'Intelligent Merge', link: '/guide/intelligent-merge' },
            { text: 'Research Tools', link: '/guide/research-tools' },
            { text: 'Lean 4 Proofs', link: '/guide/lean' },
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
            { text: 'Code Review', link: '/guide/code-review' },
            { text: 'Agent Integrations', link: '/guide/agent-integrations' },
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
      message: `<a href="${base}changelog">Changelog</a> · <a href="${base}terms">Terms of Service</a> · <a href="${base}providers">Providers</a> · <a href="${base}guide/open-source">Open Source</a>`,
      copyright: 'Copyright © 2024-2026 TeXRA Team. All rights reserved.',
    },
  },
  ignoreDeadLinks: true,
  markdown: {
    // VitePress v2 alpha does NOT wrap inline code in v-pre, so Vue
    // interpolates any `{{ ... }}` inside backticks — template-variable
    // references like `{{ INPUT_CONTENT }}` would render empty (or break the
    // build on filtered expressions like `{{ X | join(", ") }}`). Re-add
    // v-pre to every inline code token so the braces are shown literally,
    // matching how fenced code blocks already behave.
    config: (md) => {
      const defaultCodeInline =
        md.renderer.rules.code_inline ||
        ((tokens, idx, options, _env, self) =>
          `<code${self.renderAttrs(tokens[idx])}>${md.utils.escapeHtml(
            tokens[idx].content,
          )}</code>`);
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        if (token.content.includes('{{') || token.content.includes('}}')) {
          token.attrSet('v-pre', '');
        }
        return defaultCodeInline(tokens, idx, options, env, self);
      };
    },
  },
  // The public/internal docs boundary lives in ./publicDocs.js (single source
  // of truth, shared with the scripts/check-root-docs.mjs CI gate).
  srcExclude,
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

export default withMermaid(baseConfig, {
  mermaid: {},
  mermaidPlugin: { class: 'mermaid' },
});
