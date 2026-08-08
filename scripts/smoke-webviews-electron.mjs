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

const progressViewReplacements = {
  progressBundleUri: fileUri('packages/extension/dist/progressView/bundle.js'),
  progressStyleUri: fileUri('packages/extension/dist/progressView/index.css'),
};

const commonReplacements = {
  cspSource: 'file:',
  commonStyleUri: fileUri('packages/extension/src/common/styles/common.css'),
  desktopThemeTokensUri: fileUri(
    'packages/desktop/src/renderer/themeTokens.css',
  ),
  nonce,
};

const views = [
  {
    name: 'main',
    tagName: 'main-app',
    templatePath: join(extensionRoot, 'src', 'webview', 'index.html'),
    replacements: {
      mainViewBundleUri: fileUri('packages/extension/dist/webview/bundle.js'),
    },
    fixtureMessages: [
      {
        command: 'setOnboardingFunnel',
        state: 'done',
      },
      {
        command: 'setSelectedAgent',
        sessionType: 'workflow',
        agentId: 'correct',
      },
      {
        command: 'setInputFiles',
        files: ['main.tex', 'appendix.tex', 'References/2509.24978/main.tex'],
      },
      {
        command: 'setContextFiles',
        files: [
          'refs.bib',
          'References/2509.24978/only_supplement.tex',
          'ltxfront.sty',
          'References/2509.24978/revtex4-2.cls',
        ],
      },
      {
        command: 'setMediaFiles',
        files: [
          'Fig.1.pdf',
          'References/2509.24978/summary_figure_arbitrary1d_6.jpg',
        ],
      },
    ],
  },
  {
    name: 'progress',
    tagName: 'progress-app',
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    replacements: progressViewReplacements,
  },
  {
    name: 'progress-populated',
    tagName: 'progress-app',
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    attributes: {
      'data-desktop-view': 'progress',
    },
    viewport: {
      width: 420,
      height: 600,
    },
    assertions: ['progressComposerLayout'],
    seedMessages: [
      {
        command: 'updateStreams',
        streams: [
          {
            kind: 'agent',
            name: 'builtInToolUse:chat',
            label: 'chat',
            model: 'deepseekT',
            modelLabel: 'DeepSeek V4 Flash',
            agent: 'research',
            agentCategory: 'toolUse',
            creationTimestamp: 1_783_353_600_000,
            description: 'Check citation coverage and suggest BibTeX entries.',
          },
        ],
        activeStream: 'builtInToolUse:chat',
        agentFilter: 'all',
        streamStates: {
          'builtInToolUse:chat': {
            kind: 'toolUse',
            status: 'running',
            lastTimestamp: 1_783_353_600_000,
            conversationProgress: {
              toolCallCount: 1,
            },
            stage: { kind: 'round', index: 0 },
            subagents: [],
            processes: [],
          },
        },
      },
      {
        command: 'logDelta',
        streamId: 'builtInToolUse:chat',
        entries: [
          {
            seqNo: 1,
            id: 'msg-1',
            type: 'log',
            level: 'info',
            timestamp: 1_783_353_600_000,
            messageType: 'userMessage',
            text: 'hello world',
          },
          {
            seqNo: 2,
            id: 'msg-2',
            type: 'log',
            level: 'info',
            timestamp: 1_783_353_601_000,
            messageType: 'modelResponse',
            text: 'I will inspect the manuscript and report missing citations.',
          },
        ],
        updates: [],
      },
    ],
    replacements: progressViewReplacements,
  },
  {
    name: 'progress-approval',
    tagName: 'progress-app',
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    attributes: {
      'data-desktop-view': 'progress',
    },
    viewport: {
      width: 420,
      height: 700,
    },
    assertions: ['toolEditApprovalLayout'],
    seedMessages: [
      {
        command: 'updateStreams',
        streams: [
          {
            kind: 'agent',
            name: 'builtInToolUse:orchestrator',
            label: 'orchestrator',
            model: 'deepseekT',
            modelLabel: 'DeepSeek V4 Flash',
            agent: 'orchestrator',
            agentCategory: 'toolUse',
            creationTimestamp: 1_783_353_600_000,
            description:
              'Revise main.tex and ask before applying the proposed patch.',
          },
        ],
        activeStream: 'builtInToolUse:orchestrator',
        agentFilter: 'all',
        streamStates: {
          'builtInToolUse:orchestrator': {
            kind: 'toolUse',
            status: 'running',
            lastTimestamp: 1_783_353_600_000,
            conversationProgress: {
              toolCallCount: 12,
            },
            stage: { kind: 'round', index: 3 },
            subagents: [],
            processes: [],
          },
        },
      },
      {
        command: 'updatePermission',
        action: 'show',
        permission: {
          kind: 'toolEdit',
          data: {
            requestId: 'smoke-tool-edit-approval',
            streamId: 'builtInToolUse:orchestrator',
            allowBypass: true,
            path: '/tmp/texra-smoke/main.tex',
            relativePath: 'main.tex',
            sourceTool: 'edit_file',
            addedLines: 1,
            removedLines: 1,
            isLatex: true,
          },
        },
      },
      {
        command: 'logDelta',
        streamId: 'builtInToolUse:orchestrator',
        entries: [
          {
            seqNo: 1,
            id: 'approval-smoke-msg-1',
            type: 'log',
            level: 'info',
            timestamp: 1_783_353_600_000,
            messageType: 'modelResponse',
            text: 'I found a one-line correction and need approval before editing main.tex.',
          },
        ],
        updates: [],
      },
    ],
    replacements: progressViewReplacements,
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

function injectDesktopThemeTokens(html) {
  return html.replace(
    /<link rel="stylesheet" href="\$\{commonStyleUri\}" \/>/,
    `$&\n    <link rel="stylesheet" href="\${desktopThemeTokensUri}" />`,
  );
}

function escapeAttributeValue(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function serializeAttributes(attributes = {}) {
  return Object.entries(attributes)
    .map(([name, value]) => {
      if (!/^[A-Za-z_:][\w:.-]*$/.test(name)) {
        throw new Error(`Invalid smoke attribute name: ${name}`);
      }
      return ` ${name}="${escapeAttributeValue(value)}"`;
    })
    .join('');
}

function injectViewAttributes(html, view) {
  const attributes = serializeAttributes(view.attributes);
  if (!attributes) return html;

  const tagPattern = new RegExp(`<${view.tagName}(?=[\\s>])`, 'i');
  if (!tagPattern.test(html)) {
    throw new Error(`Webview template is missing <${view.tagName}>.`);
  }
  return html.replace(tagPattern, `$&${attributes}`);
}

async function prepareViewHtml(view) {
  const template = await readFile(view.templatePath, 'utf8');
  const html = injectViewAttributes(
    injectHostBridge(
      applyReplacements(injectDesktopThemeTokens(template), {
        ...commonReplacements,
        ...view.replacements,
      }),
    ),
    view,
  );
  const htmlPath = join(generatedHtmlDir, `${view.name}.html`);
  await writeFile(htmlPath, html);
  return {
    fixtureMessages: view.fixtureMessages ?? [],
    htmlPath,
    name: view.name,
    tagName: view.tagName,
    seedMessages: view.seedMessages ?? [],
    assertions: view.assertions ?? [],
    viewport: view.viewport,
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
