// Runs inside the VS Code extension host (loaded by vscode-host-e2e-runner.mjs).
// Plain CommonJS on purpose: the host `require`s it directly, no build step.
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'texra-ai.texra';

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(
    extension,
    `${EXTENSION_ID} is not loaded from extensionDevelopmentPath`,
  );
  await extension.activate();
  assert.equal(extension.isActive, true, 'the extension did not activate');

  // A manifest command with no registration is a silent failure otherwise.
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = extension.packageJSON.contributes.commands
    .map((c) => c.command)
    .filter((id) => !registered.has(id));
  assert.deepEqual(
    missing,
    [],
    `manifest commands with no registration: ${missing}`,
  );

  // The commands that open the extension's own surfaces run without throwing.
  await vscode.commands.executeCommand('texra.showProgressView');
  await vscode.commands.executeCommand('texra.showAgents');
  await vscode.commands.executeCommand('texra.openProgressViewInTab');

  // The panel opens asynchronously after the command resolves.
  const isTexraWebviewTab = (tab) =>
    tab.input instanceof vscode.TabInputWebview &&
    /texra/i.test(tab.input.viewType);
  const openTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const deadline = Date.now() + 10_000;
  while (!openTabs().some(isTexraWebviewTab) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(
    openTabs().some(isTexraWebviewTab),
    `no TeXRA webview tab opened; tabs: ${openTabs().map((t) => `${t.label} (${t.input?.constructor?.name}:${t.input?.viewType})`)}`,
  );

  // The window is a client of the background service (no service runs on
  // Windows yet): activation started it from the shipped bundle, and a task
  // this window launches runs there, not in the window. The runner checks
  // that the service outlives the window.
  if (process.platform === 'win32') return;
  const run = path.join(os.homedir(), '.texra', 'run');
  const record = path.join(run, 'serve.json');
  const until = async (label, check) => {
    const end = Date.now() + 60_000;
    while (!check()) {
      assert.ok(Date.now() < end, `timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  await until('the service record', () => existsSync(record));
  const info = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(
    info.version,
    extension.packageJSON.version,
    'the service reports the extension version it was started from',
  );
  // No provider key in this home: the task ends at once, but in the service.
  await vscode.commands
    .executeCommand('texra.execute', {
      config: {
        agent: 'setup',
        agentCategory: 'toolUse',
        model: 'openai/gpt-5.6-sol',
        instruction: 'Service E2E task',
      },
    })
    .then(
      () => undefined,
      () => undefined,
    );
  const log = () => readFileSync(path.join(run, 'serve.log'), 'utf8');
  await until('the service to start the task', () =>
    /Starting run \(runId: [0-9a-f]{12}\)/.test(log()),
  );
  // The window attached its editor (diagnostics, PDFs, tool-edit previews)
  // before its project's session was opened there.
  assert.doesNotMatch(
    log(),
    /No TeXRA window of .* is attached/,
    'the window should be attached to the service as its project window',
  );
}

module.exports = { run };
