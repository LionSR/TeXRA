import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';
import os from 'node:os';
import { formatExit, waitForExit } from './smoke-process-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const extensionRoot = join(repoRoot, 'packages', 'extension');
const mediaDir = join(extensionRoot, 'resources', 'walkthroughs', 'media');
const outputDir = join(repoRoot, 'artifacts', 'walkthrough-media');
const generatedHtmlDir = join(outputDir, 'html');
const desktopRequire = createRequire(
  join(repoRoot, 'packages', 'desktop', 'package.json'),
);
const nonce = 'texra-walkthrough-capture';

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

const mainWorkflowMessages = [
  { command: 'setAgentOptions', optionsData: agentOptions },
  { command: 'setModelOptions', optionsData: modelOptions },
  { command: 'setSelectedAgent', sessionType: 'workflow', agentId: 'correct' },
  {
    command: 'setInputFiles',
    files: ['main.tex', 'sections/introduction.tex', 'appendix.tex'],
  },
  {
    command: 'setContextFiles',
    files: [
      'references.bib',
      'notes/algebraic-expanders.tex',
      'macros.tex',
      'style/revtex4-2.cls',
    ],
  },
  {
    command: 'setMediaFiles',
    files: ['figures/spectral-gap.pdf', 'figures/proof-sketch.png'],
  },
];

function mainWebview(name, captures) {
  return {
    name,
    tagName: 'main-app',
    width: 1120,
    height: 1040,
    templatePath: join(extensionRoot, 'src', 'webview', 'index.html'),
    replacements: {
      mainViewBundleUri: fileUri('packages/extension/dist/webview/bundle.js'),
      mainViewStyleUri: fileUri('packages/extension/dist/webview/index.css'),
    },
    messageMode: 'postMessage',
    messages: mainWorkflowMessages,
    captures,
  };
}

const webviewViews = [
  mainWebview('main-auto-extract', [
    {
      target: 'auto-extract-options',
      outputPath: mediaPath('auto-extract-options.png'),
    },
  ]),
  mainWebview('main-workflow', [
    {
      target: 'file-selection',
      outputPath: mediaPath('file-selection.png'),
    },
  ]),
  {
    name: 'main-agent-model',
    tagName: 'main-app',
    width: 980,
    height: 520,
    templatePath: join(extensionRoot, 'src', 'webview', 'index.html'),
    replacements: {
      mainViewBundleUri: fileUri('packages/extension/dist/webview/bundle.js'),
      mainViewStyleUri: fileUri('packages/extension/dist/webview/index.css'),
    },
    messageMode: 'postMessage',
    messages: [
      { command: 'setAgentOptions', optionsData: agentOptions },
      { command: 'setModelOptions', optionsData: modelOptions },
      {
        command: 'setSelectedAgent',
        sessionType: 'toolUse',
        agentId: 'orchestrator',
      },
    ],
    captures: [
      {
        target: 'agent-model-selection',
        outputPath: mediaPath('agent-model-selection.png'),
      },
    ],
  },
  {
    name: 'settings-models',
    tagName: 'settings-app',
    width: 1280,
    height: 760,
    templatePath: join(extensionRoot, 'src', 'settingsView', 'index.html'),
    replacements: {
      settingsBundleUri: fileUri(
        'packages/extension/dist/settingsView/bundle.js',
      ),
      settingsStyleUri: fileUri(
        'packages/extension/dist/settingsView/index.css',
      ),
    },
    messages: [
      { command: 'setTab', tabIndex: 1 },
      {
        command: 'updateProfile',
        authenticated: false,
        user: null,
        tier: 'free',
        permissions: [],
        remoteAgents: [],
        apiAccessMode: 'personal',
        tierConstants: { ultra: 'ultra', max: 'max' },
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
  {
    name: 'progress-walkthrough',
    tagName: 'progress-app',
    width: 1280,
    height: 760,
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    attributes: {
      'data-desktop-view': 'progress',
    },
    replacements: {
      progressBundleUri: fileUri(
        'packages/extension/dist/progressView/bundle.js',
      ),
      progressStyleUri: fileUri(
        'packages/extension/dist/progressView/index.css',
      ),
    },
    messages: progressMessages(),
    captures: [
      {
        target: 'texra-progressboard',
        outputPath: mediaPath('texra-progressboard.png'),
      },
    ],
  },
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

function outputLocation(relativePath) {
  return {
    kind: 'workspace',
    absolutePath: `/workspace/${relativePath}`,
    relativePath,
  };
}

function outputFileInfo(source, relativePath, round, added, removed) {
  return {
    source,
    location: outputLocation(relativePath),
    round,
    lineage: {
      original: outputLocation('paper/main.tex'),
      diffBase: outputLocation('paper/main.tex'),
      diffFile: outputLocation(`History/diff-r${round}.tex`),
    },
    diff: {
      added,
      removed,
    },
  };
}

function progressMessages() {
  const stream = 'workflow:main.tex';
  const timestamp = 1_783_353_600_000;
  return [
    {
      command: 'updateStreams',
      streams: [
        {
          name: stream,
          label: 'main.tex',
          model: 'gemini31p',
          modelLabel: 'Gemini 3.1 Pro',
          agent: 'orchestrator',
          agentCategory: 'workflow',
          inputFile: 'paper/main.tex',
          creationTimestamp: timestamp,
          executionId: 'exec-walkthrough',
          description:
            'Coordinate edits for the spectral gap manuscript and check the generated output.',
        },
      ],
      activeStream: stream,
      agentFilter: 'all',
      streamStates: {
        [stream]: {
          kind: 'workflow',
          status: 'running',
          lastTimestamp: timestamp + 90_000,
          conversationProgress: {
            toolCallCount: 5,
          },
          stage: { kind: 'round', index: 1 },
          subagents: [
            {
              executionId: 'exec-polish',
              agentName: 'polish',
              childStreamId: 'toolUse:polish',
              status: 'running',
              elapsed: '42s',
            },
            {
              executionId: 'exec-outline',
              agentName: 'outline',
              childStreamId: 'toolUse:outline',
              status: 'completed',
              elapsed: '1m 12s',
              finishedAt: timestamp + 60_000,
            },
          ],
          processes: [],
        },
      },
    },
    {
      command: 'logDelta',
      streamId: stream,
      entries: [
        logEntry(
          1,
          'user-1',
          timestamp,
          'userMessage',
          'Improve the introduction and check that the theorem statement is mathematically precise.',
        ),
        logEntry(
          2,
          'assistant-1',
          timestamp + 15_000,
          'modelResponse',
          'I will inspect the manuscript, propose a focused polishing pass, and keep the original files unchanged.',
        ),
        {
          seqNo: 3,
          id: 'tool-1',
          type: 'log',
          level: 'info',
          timestamp: timestamp + 35_000,
          messageType: 'toolUse',
          text: 'proposal',
          data: {
            toolName: 'delegate_to_agent',
            input: {
              agent: 'polish',
              model: 'gemini31p',
              instruction:
                'Tighten the exposition in the introduction and preserve all LaTeX notation.',
              inputFiles: ['paper/main.tex'],
              contextFiles: ['references.bib'],
              mediaFiles: ['figures/spectral-gap.pdf'],
              outputFiles: ['History/main_polished.tex'],
              toolConfig: {
                autoExtractFigure: true,
                autoExtractTikzFigure: true,
                autoCompileInputPdf: false,
                attachTeXCount: true,
                attachDiagnostics: true,
              },
              agentCategory: 'workflow',
            },
            output: {
              summary: 'Prepared a polishing task for paper/main.tex.',
            },
            status: 'completed',
          },
        },
      ],
      updates: [],
    },
    {
      command: 'updateFiles',
      stream,
      reset: true,
      rounds: {
        1: [
          outputFileInfo('output.tex', 'History/main_polished.tex', 1, 31, 12),
          outputFileInfo('output.xml', 'History/output.xml', 1, 6, 0),
        ],
      },
    },
    {
      command: 'updateRunUsage',
      stream,
      runId: 'exec-walkthrough',
      usage: {
        inputTokens: 18240,
        outputTokens: 3240,
        cacheReadInputTokens: 8900,
        cacheCreationInputTokens: 2100,
        cacheMissInputTokens: 9340,
        cost: 0.42,
      },
    },
    {
      command: 'updatePermission',
      action: 'show',
      permission: {
        kind: 'proposal',
        data: {
          proposalId: 'proposal-polish-intro',
          streamId: stream,
          agent: 'polish',
          model: 'gemini31p',
          instruction:
            'Tighten the exposition in the introduction and preserve all mathematical notation.',
          memories: [],
          workingDirectory: null,
          inputFiles: ['paper/main.tex'],
          contextFiles: ['references.bib', 'macros.tex'],
          mediaFiles: ['figures/spectral-gap.pdf'],
          outputFiles: ['History/main_polished.tex'],
          toolConfig: {
            autoExtractFigure: true,
            autoExtractTikzFigure: true,
            autoCompileInputPdf: false,
            attachTeXCount: true,
            attachDiagnostics: true,
          },
          agentCategory: 'workflow',
        },
      },
    },
  ];
}

function logEntry(seqNo, id, timestamp, messageType, text) {
  return {
    seqNo,
    id,
    type: 'log',
    level: 'info',
    timestamp,
    messageType,
    text,
  };
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
    const texraCaptureBridge = {
      _state: undefined,
      postMessage(message) {
        window.__texraCaptureMessages = [...(window.__texraCaptureMessages ?? []), message];
      },
      getState() {
        return this._state;
      },
      setState(state) {
        this._state = state;
      },
    };
    window.__texraHostBridgeApi = texraCaptureBridge;
    window.acquireVsCodeApi = () => texraCaptureBridge;

    // Capture loads the bundled desktop view directly, where repeated Web
    // Awesome imports can try to register the same wa-* element twice.
    const nativeDefine = customElements.define.bind(customElements);
    customElements.define = (name, constructor, options) => {
      if (name.startsWith('wa-') && customElements.get(name)) {
        return undefined;
      }
      return nativeDefine(name, constructor, options);
    };
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
        throw new Error(`Invalid capture attribute name: ${name}`);
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
    captures: view.captures,
    height: view.height,
    htmlPath,
    messageMode: view.messageMode,
    messages: view.messages ?? [],
    name: view.name,
    tagName: view.tagName,
    width: view.width,
  };
}

function assertBuiltAssetsExist() {
  const required = [
    'packages/extension/dist/webview/bundle.js',
    'packages/extension/dist/webview/index.css',
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
  const electronBinaryPath = desktopRequire('electron');
  const runnerPath = join(
    repoRoot,
    'scripts',
    'capture-walkthrough-media-runner.cjs',
  );
  const electronArgs =
    process.env.TEXRA_WALKTHROUGH_CAPTURE_NO_SANDBOX === '1'
      ? ['--no-sandbox', runnerPath]
      : [runnerPath];
  const child = spawn(electronBinaryPath, electronArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEXRA_WALKTHROUGH_CAPTURE_CONFIG: configPath,
    },
    stdio: 'inherit',
  });

  const exit = await waitForExit(child);
  if (exit.code === 0) return;

  throw new Error(
    `Electron walkthrough capture failed with ${formatExit(exit)}.`,
  );
}

function vscodeExecutablePath() {
  if (process.env.TEXRA_VSCODE_EXECUTABLE) {
    return process.env.TEXRA_VSCODE_EXECUTABLE;
  }
  if (process.platform === 'darwin') {
    return '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
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

await rm(outputDir, { recursive: true, force: true });
await mkdir(generatedHtmlDir, { recursive: true });
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
