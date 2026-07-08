// Web Awesome registration entry. Each webview frontend imports this once
// (side-effect only). Loads the WA default theme stylesheet so wa-* component
// tokens have defaults; host-specific overrides (--wa-* mapped from
// --vscode-* or desktop tokens) live in:
//   - packages/extension/src/common/styles/common.css   (VS Code)
//   - packages/desktop/src/renderer/themeTokens.css     (Electron)
//
// App entry points import registration from ./webAwesomeIcons directly because
// icon registration is intentionally a one-time side effect at webview startup.
// Component imports themselves (e.g. wa-button, wa-input) live alongside the
// component family they belong to — added in subsequent migration PRs.

import '@awesome.me/webawesome/dist/styles/themes/default.css';

import { registerTeXRAWebAwesomeIcons } from './webAwesomeIcons';
import { applyInitialWaColorScheme } from './waColorScheme';

registerTeXRAWebAwesomeIcons();
applyInitialWaColorScheme();
