import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  renderWebviewHtml,
  renderSessionHarnessBridge,
  runElectronWebviewHarness,
} from './webview-electron-harness.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const extensionRoot = join(repoRoot, 'packages', 'extension');
const outputDir = join(repoRoot, 'artifacts', 'webview-smoke');
const generatedHtmlDir = join(outputDir, 'html');
const desktopRequire = createRequire(
  join(repoRoot, 'packages', 'desktop', 'package.json'),
);
const nonce = 'texra-webview-smoke';

// The progress webview is the one bundle the sidebar and the editor tab
// load. It renders nothing until the host answers its `subscribe` with an
// events frame carrying the host snapshot, so each progress view carries a
// session fixture: the bridge shim below plays the host, answering every
// subscribe with the fixture's events (listing rows for every stream, the
// transcript tier for the aggregates the subscribe named), the way
// `SessionFramer` cuts a frame.
const SESSION_KEY = '/tmp/texra-smoke/paper';
const OWNER = '["test-host",4242,"2026-09-04T00:00:00.000Z"]';
const NOW = 1_783_353_600_000;
const STREAM = 'research#smoke0000001';
const EXECUTION = 'a1b2c3d4e5f6';
const CHILD_STREAM = 'reviewer#smoke0000002';
const CHILD_EXECUTION = 'b1b2c3d4e5f6';

const hostSnapshot = {
  paper: {
    key: SESSION_KEY,
    name: 'paper',
    initials: 'PA',
    subtitle: SESSION_KEY,
  },
  agentOptions: {
    toolUse: [
      { value: 'orchestrator', label: 'orchestrator' },
      { value: 'research', label: 'research' },
    ],
    workflow: [{ value: 'correct', label: 'correct' }],
  },
  modelOptions: [{ value: 'deepseekT', label: 'DeepSeek V4 Flash' }],
  teamOptions: [],
  workspaceRoots: [],
  fileConfigs: [
    {
      type: 'input',
      label: 'Input',
      icon: 'file-code',
      addOpenedLabel: 'Add opened files as input',
      emptyListLabel: 'Clear all input files',
      selectListLabel: 'Add input files',
      toolConfig: 'tool',
    },
    {
      type: 'context',
      label: 'Context',
      icon: 'book',
      addOpenedLabel: 'Add opened files as context',
      emptyListLabel: 'Clear all context files',
      selectListLabel: 'Add context files',
    },
    {
      type: 'media',
      label: 'Media',
      icon: 'video',
      addOpenedLabel: 'Add opened files as media',
      emptyListLabel: 'Clear all media files',
      selectListLabel: 'Add media files',
      toolConfig: 'autoExtract',
    },
  ],
  fileOptions: { baseFile: [], editedFile: [], commit: ['HEAD'] },
  isGitRepo: false,
  recording: null,
  debugMode: false,
  banners: {
    apiKey: { visible: false },
    agentConfig: { visible: false },
    dependency: { visible: false },
    gettingStarted: false,
    login: false,
  },
  onboarding: 'done',
};

/** Seq numbered per aggregate and committed in one session order. */
function sessionLog() {
  const events = [];
  const seqs = new Map();
  const entrySeqs = new Map();
  let commit = 0;
  const emit = (logicalId, at, body) => {
    const aggregateId = JSON.stringify(['stream', logicalId]);
    const seq = (seqs.get(aggregateId) ?? 0) + 1;
    seqs.set(aggregateId, seq);
    commit += 1;
    events.push({ aggregateId, seq, commit, ownerId: OWNER, at, ...body });
  };
  const entry = (streamId, at, fields) => {
    const seqNo = (entrySeqs.get(streamId) ?? 0) + 1;
    entrySeqs.set(streamId, seqNo);
    emit(streamId, at, {
      type: 'transcript.entry',
      entry: { seqNo, level: 'info', timestamp: at, type: 'log', ...fields },
    });
  };
  return { events, emit, entry };
}

function startRun(log, { streamId, executionId, agent, at, parentStreamId }) {
  log.emit(streamId, at, {
    type: 'run.start',
    executionId,
    identity: { kind: 'agent', agent },
    category: 'toolUse',
    isRemote: false,
    userFollowUpSupport: 'nativeInteractive',
    approvalPolicy: {
      policy: 'ask',
      bypasses: { bash: false, toolEdit: false, superYolo: false },
    },
    ...(parentStreamId ? { parentStreamId } : {}),
  });
  log.emit(streamId, at, {
    type: 'run.activate',
    category: 'toolUse',
    isRemote: false,
    background: false,
  });
  log.emit(streamId, at, {
    type: 'run.config',
    executionId,
    config: { model: 'deepseekT', agent, inputFiles: ['main.tex'] },
  });
  log.emit(streamId, at, {
    type: 'status',
    phase: 'running',
    cause: 'lifecycle',
    runStartedAt: at,
  });
}

function conversationEvents({ approval = false } = {}) {
  const log = sessionLog();
  startRun(log, {
    streamId: STREAM,
    executionId: EXECUTION,
    agent: 'research',
    at: NOW,
  });
  log.emit(STREAM, NOW + 500, {
    type: 'updateStreamDescription',
    description: 'Check citation coverage and suggest BibTeX entries.',
  });
  log.entry(STREAM, NOW, {
    id: 'msg-1',
    messageType: 'userMessage',
    text: 'hello world',
  });
  log.entry(STREAM, NOW + 1000, {
    id: 'msg-2',
    messageType: 'modelResponse',
    text: 'I will inspect the manuscript and report missing citations.',
  });
  log.emit(STREAM, NOW + 1500, {
    type: 'conversation.progress',
    progress: { toolCallCount: 1 },
  });
  if (approval) {
    startRun(log, {
      streamId: CHILD_STREAM,
      executionId: CHILD_EXECUTION,
      agent: 'reviewer',
      at: NOW + 2000,
      parentStreamId: STREAM,
    });
    log.emit(STREAM, NOW + 3000, {
      type: 'approval.requested',
      requestId: 'smoke-tool-edit-approval',
      payload: {
        kind: 'toolEdit',
        data: {
          requestId: 'smoke-tool-edit-approval',
          streamId: STREAM,
          allowBypass: true,
          path: '/tmp/texra-smoke/main.tex',
          relativePath: 'main.tex',
          sourceTool: 'edit_file',
          addedLines: 1,
          removedLines: 1,
          isLatex: true,
        },
      },
    });
    log.entry(STREAM, NOW + 3000, {
      id: 'msg-3',
      messageType: 'modelResponse',
      text: 'I found a one-line correction and need approval before editing main.tex.',
    });
  }
  return log.events;
}

const progressViewReplacements = {
  bundleUri: fileUri('packages/extension/dist/progressView/bundle.js'),
  styleUri: fileUri('packages/extension/dist/progressView/index.css'),
  sessionKey: SESSION_KEY,
  placement: 'sidebar',
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
    name: 'progress',
    tagName: 'progress-app',
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    replacements: progressViewReplacements,
    session: { host: hostSnapshot, events: [], selected: null },
  },
  {
    name: 'progress-populated',
    tagName: 'progress-app',
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    viewport: {
      width: 420,
      height: 600,
    },
    assertions: ['progressComposerLayout'],
    replacements: progressViewReplacements,
    session: {
      host: hostSnapshot,
      events: conversationEvents(),
      selected: STREAM,
    },
  },
  {
    name: 'progress-approval',
    tagName: 'progress-app',
    templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
    viewport: {
      width: 420,
      height: 700,
    },
    assertions: ['toolEditApprovalLayout'],
    replacements: progressViewReplacements,
    session: {
      host: hostSnapshot,
      events: conversationEvents({ approval: true }),
      selected: STREAM,
    },
  },
  {
    name: 'settings',
    tagName: 'settings-app',
    templatePath: join(extensionRoot, 'src', 'settingsView', 'index.html'),
    replacements: {
      bundleUri: fileUri('packages/extension/dist/settingsView/bundle.js'),
    },
  },
];

function fileUri(relativePath) {
  return pathToFileURL(join(repoRoot, relativePath)).toString();
}

async function prepareViewHtml(view) {
  const template = await readFile(view.templatePath, 'utf8');
  const html = renderWebviewHtml(template, {
    attributeLabel: 'smoke',
    bridgeScript: renderSessionHarnessBridge({
      nonce,
      sessionKey: SESSION_KEY,
      owner: OWNER,
      session: view.session,
      messagesKey: '__texraSmokeMessages',
    }),
    replacements: { ...commonReplacements, ...view.replacements },
    view,
  });
  const htmlPath = join(generatedHtmlDir, `${view.name}.html`);
  await writeFile(htmlPath, html);
  return {
    htmlPath,
    name: view.name,
    tagName: view.tagName,
    assertions: view.assertions ?? [],
    viewport: view.viewport,
  };
}

async function runElectron(configPath) {
  await runElectronWebviewHarness({
    configEnv: 'TEXRA_WEBVIEW_SMOKE_CONFIG',
    configPath,
    cwd: repoRoot,
    electronBinaryPath: desktopRequire('electron'),
    failureLabel: 'Electron webview smoke',
    noSandboxEnv: 'TEXRA_WEBVIEW_SMOKE_NO_SANDBOX',
    runnerPath: join(repoRoot, 'scripts', 'smoke-webviews-electron-runner.cjs'),
  });
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
