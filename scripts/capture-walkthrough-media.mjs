import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import os from 'node:os';
import {
  renderWebviewHtml,
  renderSessionHarnessBridge,
  runElectronWebviewHarness,
} from './webview-electron-harness.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const extensionRoot = join(repoRoot, 'packages', 'extension');
const mediaDir = join(extensionRoot, 'resources', 'walkthroughs', 'media');
const outputDir = join(repoRoot, 'artifacts', 'walkthrough-media');
const generatedHtmlDir = join(outputDir, 'html');
const desktopRequire = createRequire(
  join(repoRoot, 'packages', 'desktop', 'package.json'),
);
const nonce = 'texra-walkthrough-capture';

// Use the session fixture and host catalog consumed by the current shell.
await rm(outputDir, { recursive: true, force: true });
await mkdir(generatedHtmlDir, { recursive: true });
const fixturePath = join(outputDir, 'session-fixture.cjs');
await build({
  stdin: {
    contents: `export { buildScenario, ROOT, OWNER, BOARD_NOW } from './src/test-kernel/shared/session/fanOutScenario';
      export { emptyHostSnapshot } from './src/shared/session/hostSnapshot';
      export { FILE_SELECT_CONFIGS } from './src/shared/launcher/fileSelectConfigs';`,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: fixturePath,
  tsconfig: join(repoRoot, 'tsconfig.json'),
});
const {
  buildScenario,
  ROOT,
  OWNER,
  BOARD_NOW,
  emptyHostSnapshot,
  FILE_SELECT_CONFIGS,
} = desktopRequire(fixturePath);
const SESSION_KEY = '/workspace/spectral-gap';

const commonReplacements = {
  cspSource: 'file:',
  commonStyleUri: fileUri('packages/extension/src/common/styles/common.css'),
  desktopThemeTokensUri: fileUri(
    'packages/desktop/src/renderer/themeTokens.css',
  ),
  nonce,
};

const providers = [
  providerStatus('openai', 'OpenAI', 'not-set'),
  providerStatus('anthropic', 'Anthropic', 'set'),
  providerStatus('google', 'Google', 'not-set'),
  providerStatus('deepseek', 'DeepSeek', 'env'),
  providerStatus('xai', 'xAI', 'not-set'),
];

const modelOptions = [
  {
    label: 'Gemini 3.1 Pro',
    value: 'gemini31p',
    provider: 'google',
    context: '1M',
    cost: '$$',
    availability: 'provider-key',
    availabilityLabel: 'API key',
  },
  {
    label: 'GPT-5.5',
    value: 'gpt-5.5',
    provider: 'openai',
    context: '400k',
    cost: '$$$',
    availability: 'missing-key',
    availabilityLabel: 'Needs key',
  },
  {
    label: 'DeepSeek V4 Flash',
    value: 'deepseekT',
    provider: 'deepseek',
    context: '128k',
    cost: '$',
    availability: 'provider-key',
    availabilityLabel: 'Env key',
  },
];

const agentOptions = {
  workflow: [
    {
      label: 'Correct',
      value: 'correct',
      description: 'Fix LaTeX errors and preserve mathematical notation.',
    },
    {
      label: 'Polish',
      value: 'polish',
      description: 'Tighten exposition while keeping the proof structure.',
    },
  ],
  toolUse: [
    {
      label: 'orchestrator',
      value: 'orchestrator',
      isToolUse: true,
      isOrchestrator: true,
      description: 'Plan work and delegate to specialized agents.',
    },
    {
      label: 'research',
      value: 'research',
      isToolUse: true,
      description: 'Inspect files, search references, and answer questions.',
    },
  ],
};

const host = {
  ...emptyHostSnapshot({
    key: SESSION_KEY,
    name: 'Spectral gap',
    initials: 'SG',
    subtitle: SESSION_KEY,
  }),
  agentOptions,
  modelOptions,
  fileConfigs: FILE_SELECT_CONFIGS,
  workspaceRoots: [{ value: SESSION_KEY, label: 'Spectral gap' }],
  fileOptions: {
    baseFile: ['main.tex'],
    editedFile: ['main.tex'],
    commit: ['HEAD'],
  },
  onboarding: 'done',
};
const launch = {
  sessionType: 'workflow',
  model: 'gemini31p',
  inputFiles: ['main.tex', 'sections/introduction.tex', 'appendix.tex'],
  contextFiles: [
    'references.bib',
    'notes/algebraic-expanders.tex',
    'macros.tex',
  ],
  mediaFiles: ['figures/spectral-gap.pdf', 'figures/proof-sketch.png'],
};
function conversationWebview(
  name,
  captures,
  session = { host, events: [], selected: null, surface: { launch } },
) {
  return {
    name,
    tagName: 'progress-app',
    width: 1120,
    height: 1040,
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    replacements: {
      bundleUri: fileUri('packages/extension/dist/progressView/bundle.js'),
      styleUri: fileUri('packages/extension/dist/progressView/index.css'),
      sessionKey: SESSION_KEY,
      placement: 'tab',
    },
    session,
    nowMs: BOARD_NOW,
    captures,
  };
}

const webviewViews = [
  conversationWebview('launcher-auto-extract', [
    {
      target: 'auto-extract-options',
      outputPath: mediaPath('auto-extract-options.png'),
    },
  ]),
  conversationWebview('launcher-files', [
    {
      target: 'file-selection',
      outputPath: mediaPath('file-selection.png'),
    },
  ]),
  conversationWebview('launcher-agent-model', [
    {
      target: 'agent-model-selection',
      outputPath: mediaPath('agent-model-selection.png'),
    },
  ]),
  {
    name: 'settings-models',
    tagName: 'settings-app',
    width: 1280,
    height: 760,
    templatePath: join(extensionRoot, 'src', 'settingsView', 'index.html'),
    replacements: {
      bundleUri: fileUri('packages/extension/dist/settingsView/bundle.js'),
      styleUri: fileUri('packages/extension/dist/settingsView/index.css'),
    },
    messages: [
      { command: 'setTab', tab: 'models' },
      {
        command: 'updateProfile',
        authenticated: false,
        user: null,
        providerKeyStatuses: providers,
        globalStreamingDefault: true,
      },
      {
        command: 'updateModelSelection',
        models: [
          modelSelection(
            'anthropic',
            'claude-sonnet-4.5',
            'Claude Sonnet 4.5',
            true,
          ),
          modelSelection('openai', 'gpt-5.5', 'GPT-5.5', false),
          modelSelection('google', 'gemini31p', 'Gemini 3.1 Pro', true),
          modelSelection('deepseek', 'deepseekT', 'DeepSeek V4 Flash', true),
        ],
        helperModel: 'gemini31p',
        preferShortModelNames: false,
      },
    ],
    captures: [
      {
        target: 'api-key-setup',
        outputPath: mediaPath('api-key-setup.png'),
      },
    ],
  },
  conversationWebview(
    'progress-walkthrough',
    [
      {
        target: 'texra-progressboard',
        outputPath: mediaPath('texra-progressboard.png'),
      },
    ],
    {
      host,
      events: buildScenario({ proposal: true })
        .pending.filter((input) => input._tag === 'event')
        .map((input) => input.event),
      selected: ROOT,
      surface: { drawerOpen: false, expanded: [[ROOT, 'expanded']] },
    },
  ),
];

function fileUri(relativePath) {
  return pathToFileURL(join(repoRoot, relativePath)).toString();
}

function mediaPath(filename) {
  return join(mediaDir, filename);
}

function providerStatus(provider, displayName, status) {
  return {
    provider,
    displayName,
    status,
    keyUrl: `https://example.com/${provider}/keys`,
    streaming: true,
    customEndpoint: '',
    supportsCustomEndpoint: provider === 'openai',
    providerSettings: [],
  };
}

function modelSelection(provider, name, label, enabled) {
  return {
    name,
    label,
    provider,
    enabled,
    deprecated: false,
    contextWindow: provider === 'google' ? '1M' : '128k',
    cost: enabled ? '$$' : '$$$',
    supportsReasoningLevel: provider === 'openai',
    defaultReasoningLevel: provider === 'openai' ? 'high' : undefined,
    isFast: provider === 'deepseek',
  };
}

async function prepareViewHtml(view) {
  const template = await readFile(view.templatePath, 'utf8');
  const html = renderWebviewHtml(template, {
    attributeLabel: 'capture',
    bridgeScript: renderSessionHarnessBridge({
      nonce,
      sessionKey: SESSION_KEY,
      owner: OWNER,
      session: view.session,
      messagesKey: '__texraCaptureMessages',
      nowMs: view.nowMs,
    }),
    replacements: { ...commonReplacements, ...view.replacements },
    view,
  });
  const htmlPath = join(generatedHtmlDir, `${view.name}.html`);
  await writeFile(htmlPath, html);
  return {
    captures: view.captures,
    height: view.height,
    htmlPath,
    messages: view.messages ?? [],
    name: view.name,
    tagName: view.tagName,
    width: view.width,
  };
}

function assertBuiltAssetsExist() {
  const required = [
    'packages/extension/dist/settingsView/bundle.js',
    'packages/extension/dist/settingsView/index.css',
    'packages/extension/dist/progressView/bundle.js',
    'packages/extension/dist/progressView/index.css',
  ];
  const missing = required.filter(
    (relativePath) => !existsSync(join(repoRoot, relativePath)),
  );
  if (missing.length === 0) return;
  throw new Error(
    [
      'Missing built webview assets:',
      ...missing.map((relativePath) => `  - ${relativePath}`),
      'Run `npm run vite:webviews` before capturing walkthrough media.',
    ].join('\n'),
  );
}

async function runElectron(configPath) {
  await runElectronWebviewHarness({
    configEnv: 'TEXRA_WALKTHROUGH_CAPTURE_CONFIG',
    configPath,
    cwd: repoRoot,
    electronBinaryPath: desktopRequire('electron'),
    failureLabel: 'Electron walkthrough capture',
    noSandboxEnv: 'TEXRA_WALKTHROUGH_CAPTURE_NO_SANDBOX',
    runnerPath: join(
      repoRoot,
      'scripts',
      'capture-walkthrough-media-runner.cjs',
    ),
  });
}

function vscodeExecutablePath() {
  if (process.env.TEXRA_VSCODE_EXECUTABLE) {
    return process.env.TEXRA_VSCODE_EXECUTABLE;
  }
  if (process.platform === 'darwin') {
    return '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  }
  return '';
}

async function captureVscodeDiff() {
  const executablePath = vscodeExecutablePath();
  if (!executablePath || !existsSync(executablePath)) {
    throw new Error(
      'Cannot capture vscode-compare.png: this script defaults to the macOS VS Code app. Set TEXRA_VSCODE_EXECUTABLE to use another executable.',
    );
  }

  const { _electron } = desktopRequire('playwright');
  const tmp = await mkdtemp(join(os.tmpdir(), 'texra-vscode-diff-'));
  const originalPath = join(tmp, 'main.tex');
  const revisedPath = join(tmp, 'main-revised.tex');
  await writeFile(originalPath, originalLatex());
  await writeFile(revisedPath, revisedLatex());

  const vscodeApp = await _electron.launch({
    executablePath,
    args: [
      '--user-data-dir',
      join(tmp, 'user-data'),
      '--extensions-dir',
      join(tmp, 'extensions'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
      '--new-window',
      '--diff',
      originalPath,
      revisedPath,
    ],
    timeout: 60_000,
  });

  try {
    const page = await vscodeApp.firstWindow();
    await vscodeApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: 40, y: 40, width: 1500, height: 820 });
    });
    const editor = page.locator('.monaco-diff-editor').first();
    await editor.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    const box = await editor.boundingBox();
    if (!box) {
      throw new Error('VS Code diff editor did not expose a bounding box.');
    }

    await page.screenshot({
      path: mediaPath('vscode-compare.png'),
      clip: {
        x: Math.floor(box.x),
        y: Math.floor(box.y),
        width: Math.min(Math.ceil(box.width), 1360),
        height: Math.min(Math.ceil(box.height), 600),
      },
    });
    console.log(
      `Captured vscode-compare -> ${mediaPath('vscode-compare.png')}`,
    );
  } finally {
    await vscodeApp.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

function originalLatex() {
  return String.raw`\section{Spectral Gap in Random Regular Graphs}

For a $d$-regular graph $G$, the largest eigenvalue of its adjacency matrix is
$\lambda_1=d$. The spectral gap is $d-\lambda_2$.

\begin{theorem}[Alon--Boppana]
For any sequence of $d$-regular graphs $G_n$ on $n$ vertices whose girth tends
to infinity as $n \to \infty$, we have
\begin{equation}
  \lambda_2(G_n) \geq 2\sqrt{d-1} - o(1).
\end{equation}
\end{theorem}
`;
}

function revisedLatex() {
  return String.raw`\section{Spectral Gap in Random Regular Graphs}

For a $d$-regular graph, it is well-known that $\lambda_1=d$. The spectral gap,
defined as $d-\lambda_2$, controls the expansion properties of the graph.

\begin{theorem}[Alon--Boppana]
For any $d$-regular graph on $n$ vertices, we have
\begin{equation}
  \lambda_2 \geq 2\sqrt{d-1} - o(1),
\end{equation}
where the $o(1)$ term tends to zero as the diameter tends to infinity.
\end{theorem}
`;
}

assertBuiltAssetsExist();

const preparedViews = [];
for (const view of webviewViews) {
  preparedViews.push(await prepareViewHtml(view));
}

for (const view of preparedViews) {
  const viewConfigPath = join(outputDir, `${view.name}.json`);
  await writeFile(
    viewConfigPath,
    `${JSON.stringify({ views: [view] }, null, 2)}\n`,
  );
  await runElectron(viewConfigPath);
}

await captureVscodeDiff();

console.log(`Walkthrough media captured in ${mediaDir}`);
