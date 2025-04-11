// .vitepress/config.js
import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'TeXRA',
  description: 'Your Intelligent Academic Research Assistant',
  head: [['link', { rel: 'icon', href: '/logo-128x128.svg' }]],
  themeConfig: {
    logo: '/logo-128x128.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/' },
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
          ],
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'AI Agents', link: '/guide/agents' },
            { text: 'Models', link: '/guide/models' },
            { text: 'File Management', link: '/guide/file-management' },
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
            { text: 'Custom Agents', link: '/guide/custom-agents' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Agent Reference', link: '/reference/agents' },
            { text: 'Model Reference', link: '/reference/models' },
            { text: 'Settings', link: '/reference/settings' },
          ],
        },
        {
          text: 'Resources',
          items: [
            { text: 'Troubleshooting', link: '/reference/troubleshooting' },
            { text: 'Best Practices', link: '/reference/best-practices' },
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
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present TeXRA Team',
    },
  },
  ignoreDeadLinks: true,
});
