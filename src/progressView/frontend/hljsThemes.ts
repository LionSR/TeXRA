/**
 * Bundled highlight.js themes for code syntax highlighting.
 * Replaces CDN loading with locally bundled CSS.
 */

// Import themes as CSS strings (Vite ?inline, Webpack asset/source)
import githubLight from 'highlight.js/styles/github.css?inline';
import githubDark from 'highlight.js/styles/github-dark.css?inline';

export const hljsThemes = {
  light: githubLight,
  dark: githubDark,
} as const;

// Style element ID for theme injection
const HLJS_STYLE_ID = 'hljs-theme-style';

/**
 * Initialize or update the highlight.js theme based on VS Code theme.
 * Creates a <style> element on first call, updates content on subsequent calls.
 */
export function updateHighlightTheme(theme: string): void {
  const isDark = theme === 'dark';
  const css = isDark ? hljsThemes.dark : hljsThemes.light;

  let style = document.getElementById(HLJS_STYLE_ID) as HTMLStyleElement | null;

  if (!style) {
    style = document.createElement('style');
    style.id = HLJS_STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = css;
}
