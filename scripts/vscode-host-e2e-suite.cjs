// Runs inside the VS Code extension host (loaded by vscode-host-e2e-runner.mjs).
// Plain CommonJS on purpose: the host `require`s it directly, no build step.
const assert = require('node:assert/strict');
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
}

module.exports = { run };
