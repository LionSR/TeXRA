// Default theme
import DefaultTheme from 'vitepress/theme';
import './custom.css';
import LaunchPage from '../components/LaunchPage.vue';

// Web Awesome: load default theme tokens and the <wa-icon> custom element,
// then register the texra icon library so codicon-style names work in
// markdown. <wa-icon> is a custom element so SSR/Vue must skip resolving it.
import '@awesome.me/webawesome/dist/styles/themes/default.css';

let waIconsRegistered = false;

async function ensureWebAwesome() {
  if (typeof window === 'undefined') return;
  if (waIconsRegistered) return;
  waIconsRegistered = true;
  await import('@awesome.me/webawesome/dist/components/icon/icon.js');
  const { registerTeXRAWebAwesomeIcons } = await import('./webAwesomeIcons.js');
  registerTeXRAWebAwesomeIcons();
}

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    // Tell Vue's template compiler that <wa-icon> is a native custom element
    // so it doesn't try to resolve it as a Vue component.
    app.config.compilerOptions ??= {};
    const existingIsCustomElement = app.config.compilerOptions.isCustomElement;
    app.config.compilerOptions.isCustomElement = (tag) => {
      if (tag.startsWith('wa-')) return true;
      return existingIsCustomElement ? existingIsCustomElement(tag) : false;
    };

    // Register custom Vue components.
    app.component('LaunchPage', LaunchPage);

    // Side-effect: load WA icon component + register texra library on the
    // client. Skipped during SSR (build-time HTML generation).
    void ensureWebAwesome();
  },
};
