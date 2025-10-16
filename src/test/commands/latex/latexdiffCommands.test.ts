import * as assert from 'assert';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import { latexdiffHelpers } from '@commands/latex/latexdiffCommands';

// Local imports - utilities
import * as systemModule from '@utils/system';
import * as configModule from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import * as openBuildModule from '@frontend/latex/openBuild';

// Local imports - errors
import * as errorHandlingModule from '@common/errors/errorHandlingUtils';

const {
  ensureLatexdiffToolInstalled,
  promptForLatexdiffMathMarkup,
  openLatexdiffResult,
} = latexdiffHelpers;

type CheckToolInstalled = typeof systemModule.checkToolInstalled;
type GetConfig = typeof configModule.getConfig;
type WorkspaceExists = typeof WorkspaceFS.exists;
type OpenBuildDisplayIfTex = typeof openBuildModule.openBuildDisplayIfTex;
type ShowLoggedMessage = typeof errorHandlingModule.showLoggedMessage;

suite('Latexdiff command helpers', () => {
  const originalCheckToolInstalled = systemModule.checkToolInstalled;
  const originalGetConfig = configModule.getConfig;
  const originalShowQuickPick = vscode.window.showQuickPick;
  const originalWorkspaceExists = WorkspaceFS.exists;
  const originalOpenBuildDisplayIfTex = openBuildModule.openBuildDisplayIfTex;
  const originalShowLoggedMessage = errorHandlingModule.showLoggedMessage;

  teardown(() => {
    (systemModule as { checkToolInstalled: CheckToolInstalled }).checkToolInstalled =
      originalCheckToolInstalled;
    (configModule as { getConfig: GetConfig }).getConfig = originalGetConfig;
    (vscode.window as { showQuickPick: typeof originalShowQuickPick }).showQuickPick =
      originalShowQuickPick;
    (WorkspaceFS as { exists: WorkspaceExists }).exists = originalWorkspaceExists;
    (openBuildModule as { openBuildDisplayIfTex: OpenBuildDisplayIfTex }).openBuildDisplayIfTex =
      originalOpenBuildDisplayIfTex;
    (errorHandlingModule as { showLoggedMessage: ShowLoggedMessage }).showLoggedMessage =
      originalShowLoggedMessage;
  });

  test('ensureLatexdiffToolInstalled returns boolean status from tool check', async () => {
    const calls: string[] = [];
    (systemModule as { checkToolInstalled: CheckToolInstalled }).checkToolInstalled =
      async (toolOrConfig, _showError) => {
        const normalized =
          typeof toolOrConfig === 'string'
            ? toolOrConfig
            : Array.isArray(toolOrConfig.command)
              ? toolOrConfig.command[0]
              : toolOrConfig.command ?? 'unknown';
        const toolName = typeof normalized === 'string' ? normalized : String(normalized);
        calls.push(toolName);
        return toolName === 'latexdiff';
      };

    const available = await ensureLatexdiffToolInstalled('latexdiff');
    const missing = await ensureLatexdiffToolInstalled('latexdiff-vc');

    assert.deepStrictEqual(calls, ['latexdiff', 'latexdiff-vc']);
    assert.strictEqual(available, true);
    assert.strictEqual(missing, false);
  });

  test('promptForLatexdiffMathMarkup prioritizes configured option and returns selection', async () => {
    (configModule as { getConfig: GetConfig }).getConfig = (<T>() =>
      'Scope' as unknown as T) as GetConfig;

    let receivedItems: Array<vscode.QuickPickItem & { value: string }> = [];
    const stubQuickPick = ((items: unknown) => {
      receivedItems = items as Array<vscode.QuickPickItem & { value: string }>;
      return Promise.resolve(receivedItems[1] as vscode.QuickPickItem);
    }) as unknown as typeof originalShowQuickPick;
    (vscode.window as { showQuickPick: typeof originalShowQuickPick }).showQuickPick =
      stubQuickPick;

    const selection = await promptForLatexdiffMathMarkup();

    assert.ok(receivedItems.length > 1, 'Quick pick items should be provided');
    assert.strictEqual(receivedItems[0].label, 'Scope');
    assert.strictEqual(receivedItems[0].picked, true);
    assert.strictEqual(selection, receivedItems[1].value);
  });

  test('openLatexdiffResult resolves and opens single-file diff output', async () => {
    const existsCalls: string[] = [];
    (WorkspaceFS as { exists: WorkspaceExists }).exists = async (filePath) => {
      existsCalls.push(filePath);
      return true;
    };

    let openedPath: string | undefined;
    (openBuildModule as { openBuildDisplayIfTex: OpenBuildDisplayIfTex }).openBuildDisplayIfTex =
      async (filePath) => {
        openedPath = filePath;
      };

    const diffPath = await openLatexdiffResult('chapters/ch1.tex', 'ch1_diff.tex');

    assert.strictEqual(diffPath, 'chapters/ch1_diff.tex');
    assert.deepStrictEqual(existsCalls, ['chapters/ch1_diff.tex']);
    assert.strictEqual(openedPath, 'chapters/ch1_diff.tex');
  });

  test('openLatexdiffResult resolves diff inside directory for multi-file flows', async () => {
    let checkedPath: string | undefined;
    (WorkspaceFS as { exists: WorkspaceExists }).exists = async (filePath) => {
      checkedPath = filePath;
      return true;
    };

    (openBuildModule as { openBuildDisplayIfTex: OpenBuildDisplayIfTex }).openBuildDisplayIfTex =
      async () => {
        /* no-op for test */
      };

    const diffPath = await openLatexdiffResult('chapters', 'rounds/ch2_diff.tex');

    assert.strictEqual(checkedPath, path.join('chapters', 'rounds/ch2_diff.tex'));
    assert.strictEqual(diffPath, path.join('chapters', 'rounds/ch2_diff.tex'));
  });

  test('openLatexdiffResult shows message when diff file missing', async () => {
    (WorkspaceFS as { exists: WorkspaceExists }).exists = async () => false;

    let message: string | undefined;
    (errorHandlingModule as { showLoggedMessage: ShowLoggedMessage }).showLoggedMessage =
      async (_channel, content: string) => {
        message = content;
        return content;
      };

    const diffPath = await openLatexdiffResult('main.tex', 'missing_diff.tex');

    assert.strictEqual(diffPath, undefined);
    assert.ok(
      message?.includes('missing_diff.tex'),
      'Expected missing diff message to include file name',
    );
  });
});
