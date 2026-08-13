// Default theme
import DefaultTheme from 'vitepress/theme';

// Web Awesome: load the default theme tokens FIRST (it wraps its tokens in
// `@layer wa-theme`, so any unlayered overrides in our own CSS below always
// win), then our overrides.
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import './custom.css';
import './mockup.css';

import LaunchPage from '../components/LaunchPage.vue';
import LandingHero from '../components/LandingHero.vue';
import GuideIntroHero from '../components/GuideIntroHero.vue';
import QuickStartHero from '../components/QuickStartHero.vue';
import LatexDiffHero from '../components/LatexDiffHero.vue';
import FileSelectHero from '../components/FileSelectHero.vue';
import ApiKeysHero from '../components/ApiKeysHero.vue';
import ToolConfigHero from '../components/ToolConfigHero.vue';
import CompareHero from '../components/CompareHero.vue';
import MemoryHero from '../components/MemoryHero.vue';
import MemoryCommandsHero from '../components/MemoryCommandsHero.vue';
import MemoryPinHero from '../components/MemoryPinHero.vue';

// Frameless mock-UI system: a focused panel primitive + consolidated building
// blocks, so a page can show ONE component without the full VS Code window.
// (MockupPanel and MockSwitch are not registered here: every consumer is a
// sibling .vue component that imports them locally, none is used directly
// from markdown, so global registration would be dead weight.)
import MockCard from '../components/MockCard.vue';
import TermWindow from '../components/TermWindow.vue';
import StatusPill from '../components/StatusPill.vue';
import AgentClasses from '../components/AgentClasses.vue';
import ToolCallPanel from '../components/ToolCallPanel.vue';
import FeatureCards from '../components/FeatureCards.vue';
import DropdownMenu from '../components/DropdownMenu.vue';
import FlowSteps from '../components/FlowSteps.vue';
import DesktopMigrationSplit from '../components/DesktopMigrationSplit.vue';
import TemplateVarsPalette from '../components/TemplateVarsPalette.vue';
import AgentCatalog from '../components/AgentCatalog.vue';

let waRegistered = false;

// Load the <wa-icon> custom element + register the texra icon library, plus the
// handful of Web Awesome components the mockups bridge to (wa-switch, wa-spinner)
// and the prose uses (wa-callout, wa-badge, wa-tag, wa-card). All client-only.
async function ensureWebAwesome() {
  if (typeof window === 'undefined') return;
  if (waRegistered) return;
  waRegistered = true;
  // Icons are the critical, most-used element — load + register them first so a
  // failure in any other component import can never break the icon library.
  await import('@awesome.me/webawesome/dist/components/icon/icon.js');
  const { registerTeXRAWebAwesomeIcons } = await import('./webAwesomeIcons.js');
  registerTeXRAWebAwesomeIcons();
  // The bridged mockup controls (wa-switch, wa-spinner) and prose components
  // (wa-callout, wa-badge, wa-tag, wa-card). Tolerant: one failure won't block
  // the others or the icons above.
  await Promise.allSettled([
    import('@awesome.me/webawesome/dist/components/switch/switch.js'),
    import('@awesome.me/webawesome/dist/components/spinner/spinner.js'),
    import('@awesome.me/webawesome/dist/components/callout/callout.js'),
    import('@awesome.me/webawesome/dist/components/badge/badge.js'),
    import('@awesome.me/webawesome/dist/components/tag/tag.js'),
    import('@awesome.me/webawesome/dist/components/card/card.js'),
  ]);
}

// Web Awesome reads dark mode from a `.wa-dark` ancestor; VitePress toggles
// `.dark` on <html>. Mirror one onto the other so wa-* components (in prose and
// the bridged ones in mockups) flip with the docs theme.
function syncWaColorScheme() {
  if (typeof window === 'undefined') return;
  const html = document.documentElement;
  const apply = () => {
    const dark = html.classList.contains('dark');
    html.classList.toggle('wa-dark', dark);
    html.classList.toggle('wa-light', !dark);
  };
  apply();
  new MutationObserver(apply).observe(html, {
    attributes: true,
    attributeFilter: ['class'],
  });
}

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    // Note: `isCustomElement: tag => tag.startsWith('wa-')` is configured
    // at build time in `docs/.vitepress/config.js` under
    // `vite.vue.template.compilerOptions` so SSR also recognises wa-* tags.
    app.component('LaunchPage', LaunchPage);
    app.component('LandingHero', LandingHero);
    app.component('GuideIntroHero', GuideIntroHero);
    app.component('QuickStartHero', QuickStartHero);
    app.component('LatexDiffHero', LatexDiffHero);
    app.component('FileSelectHero', FileSelectHero);
    app.component('ApiKeysHero', ApiKeysHero);
    app.component('ToolConfigHero', ToolConfigHero);
    app.component('CompareHero', CompareHero);
    app.component('MemoryHero', MemoryHero);
    app.component('MemoryCommandsHero', MemoryCommandsHero);
    app.component('MemoryPinHero', MemoryPinHero);

    // Frameless mock-UI primitives (also usable directly in markdown).
    app.component('MockCard', MockCard);
    app.component('TermWindow', TermWindow);
    app.component('StatusPill', StatusPill);
    app.component('AgentClasses', AgentClasses);
    app.component('ToolCallPanel', ToolCallPanel);
    app.component('FeatureCards', FeatureCards);
    app.component('DropdownMenu', DropdownMenu);
    app.component('FlowSteps', FlowSteps);
    app.component('DesktopMigrationSplit', DesktopMigrationSplit);
    app.component('TemplateVarsPalette', TemplateVarsPalette);
    app.component('AgentCatalog', AgentCatalog);

    // Side-effects (client only): load WA components + register the texra icon
    // library, and keep the WA color scheme in sync with the docs theme.
    void ensureWebAwesome();
    syncWaColorScheme();
  },
};
