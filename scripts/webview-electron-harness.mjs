import { spawn } from 'node:child_process';

import { formatExit, waitForExit } from './smoke-process-utils.mjs';

/** Render a bundled webview template for an Electron harness. */
export function renderWebviewHtml(template, options) {
  const withTheme = template.replace(
    /<link rel="stylesheet" href="\$\{commonStyleUri\}" \/>/,
    `$&\n    <link rel="stylesheet" href="\${desktopThemeTokensUri}" />`,
  );
  let html = withTheme;
  for (const [key, value] of Object.entries(options.replacements)) {
    html = html.replaceAll(`\${${key}}`, value);
  }

  const bodyTagPattern = /<body\b[^>]*>/i;
  if (!bodyTagPattern.test(html)) {
    throw new Error('Webview template is missing a <body> tag.');
  }
  html = html.replace(
    bodyTagPattern,
    (bodyTag) => `${bodyTag}\n    ${options.bridgeScript}`,
  );

  const attributes = serializeAttributes(
    options.view.attributes,
    options.attributeLabel,
  );
  if (!attributes) return html;

  const tagPattern = new RegExp(`<${options.view.tagName}(?=[\\s>])`, 'i');
  if (!tagPattern.test(html)) {
    throw new Error(`Webview template is missing <${options.view.tagName}>.`);
  }
  return html.replace(tagPattern, `$&${attributes}`);
}

/** Launch an Electron runner and require a successful exit. */
export async function runElectronWebviewHarness(options) {
  const runnerArgs =
    process.env[options.noSandboxEnv] === '1'
      ? ['--no-sandbox', options.runnerPath]
      : [options.runnerPath];
  const child = spawn(options.electronBinaryPath, runnerArgs, {
    cwd: options.cwd,
    env: {
      ...process.env,
      [options.configEnv]: options.configPath,
    },
    stdio: 'inherit',
  });

  const exit = await waitForExit(child);
  if (exit.code === 0) return;
  throw new Error(`${options.failureLabel} failed with ${formatExit(exit)}.`);
}

function serializeAttributes(attributes = {}, label) {
  return Object.entries(attributes)
    .map(([name, value]) => {
      if (!/^[A-Za-z_:][\w:.-]*$/.test(name)) {
        throw new Error(`Invalid ${label} attribute name: ${name}`);
      }
      return ` ${name}="${escapeAttributeValue(value)}"`;
    })
    .join('');
}

function escapeAttributeValue(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
