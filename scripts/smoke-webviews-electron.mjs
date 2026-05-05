import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { formatExit, waitForExit } from './smoke-process-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const extensionRoot = join(repoRoot, 'packages', 'extension');
const outputDir = join(repoRoot, 'artifacts', 'webview-smoke');
const generatedHtmlDir = join(outputDir, 'html');
const desktopRequire = createRequire(
  join(repoRoot, 'packages', 'desktop', 'package.json'),
);
const nonce = 'texra-webview-smoke';

const commonReplacements = {
  cspSource: 'file:',
  codiconUri: fileUri('node_modules/@vscode/codicons/dist/codicon.css'),
  codiconsFontUri: fileUri('node_modules/@vscode/codicons/dist/codicon.ttf'),
  commonStyleUri: fileUri('packages/extension/src/common/styles/common.css'),
  commonsBundleUri: fileUri('packages/extension/dist/shared/commons.js'),
  nonce,
  vscodeElementsBundleUri: fileUri(
    'node_modules/@vscode-elements/elements/dist/bundled.js',
  ),
};

const views = [
  {
    name: 'main',
    tagName: 'main-app',
    templatePath: join(extensionRoot, 'src', 'webview', 'index.html'),
    replacements: {
      mainViewBundleUri: fileUri('packages/extension/dist/webview/bundle.js'),
    },
  },
  {
    name: 'progress',
    tagName: 'progress-app',
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    replacements: {
      progressBundleUri: fileUri(
        'packages/extension/dist/progressView/bundle.js',
      ),
      progressStyleUri: fileUri(
        'packages/extension/dist/progressView/index.css',
      ),
    },
  },
  {
    name: 'settings',
    tagName: 'settings-app',
    templatePath: join(extensionRoot, 'src', 'settingsView', 'index.html'),
    replacements: {
      settingsBundleUri: fileUri(
        'packages/extension/dist/settingsView/bundle.js',
      ),
    },
  },
];

function fileUri(relativePath) {
  return pathToFileURL(join(repoRoot, relativePath)).toString();
}

function applyReplacements(template, replacements) {
  let html = template;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`\${${key}}`, value);
  }
  return html;
}

function hostBridgeShim() {
  const shim = `
    const texraSmokeBridge = {
      _state: undefined,
      postMessage(message) {
        window.__texraSmokeMessages = [...(window.__texraSmokeMessages ?? []), message];
      },
      getState() {
        return this._state;
      },
      setState(state) {
        this._state = state;
      },
    };
    window.__texraHostBridgeApi = texraSmokeBridge;
    window.acquireVsCodeApi = () => texraSmokeBridge;
  `;
  return `<script nonce="${nonce}">${shim}</script>`;
}

function injectHostBridge(html) {
  const bodyTagPattern = /<body\b[^>]*>/i;
  if (!bodyTagPattern.test(html)) {
    throw new Error('Webview template is missing a <body> tag.');
  }
  return html.replace(
    bodyTagPattern,
    (bodyTag) => `${bodyTag}\n    ${hostBridgeShim()}`,
  );
}

async function prepareViewHtml(view) {
  const template = await readFile(view.templatePath, 'utf8');
  const html = injectHostBridge(
    applyReplacements(template, {
      ...commonReplacements,
      ...view.replacements,
    }),
  );
  const htmlPath = join(generatedHtmlDir, `${view.name}.html`);
  await writeFile(htmlPath, html);
  return {
    htmlPath,
    name: view.name,
    tagName: view.tagName,
  };
}

async function runElectron(configPath) {
  const electronBinaryPath = desktopRequire('electron');
  const runnerPath = join(
    repoRoot,
    'scripts',
    'smoke-webviews-electron-runner.cjs',
  );
  const electronArgs =
    process.env.TEXRA_WEBVIEW_SMOKE_NO_SANDBOX === '1'
      ? ['--no-sandbox', runnerPath]
      : [runnerPath];
  const child = spawn(electronBinaryPath, electronArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEXRA_WEBVIEW_SMOKE_CONFIG: configPath,
    },
    stdio: 'inherit',
  });

  const exit = await waitForExit(child);
  if (exit.code === 0) return;

  throw new Error(`Electron webview smoke failed with ${formatExit(exit)}.`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(generatedHtmlDir, { recursive: true });
const smokeViews = [];
for (const view of views) {
  smokeViews.push(await prepareViewHtml(view));
}

const configPath = join(outputDir, 'config.json');
await writeFile(
  configPath,
  `${JSON.stringify({ outputDir, views: smokeViews }, null, 2)}\n`,
);
await runElectron(configPath);
console.log(`Electron webview smoke passed. Screenshots: ${outputDir}`);
