// An agent's document-task proposal, edited in the desktop app before it
// runs (#14276). A task in the background service proposes a document task,
// on the newer build's scripted model, and waits for the answer. The
// proposal card's Edit opens the launch form on the proposal, and Back
// returns to the asking task with the proposal still waiting. An edit that
// adds a context file and rewrites the instruction approves the child with
// both, and Run again… on the finished child opens the form on that setup
// and launches the same task again.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test, type Page } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
} from './electronApp.js';
import {
  NEXT_BUILD,
  alive,
  buildCli,
  cli,
  scriptedModel,
  serviceStatus,
} from './serviceFixture.js';
import { cleanupDirectory } from './workspaceStorageFixture.js';

const PROPOSED = 'Tighten the prose.';
const EDITED = 'Tighten the prose; keep the macros.';

/** The rows `sql` selects from the store of the scratch `work` project;
 *  none before the service creates it. */
function storeRows<T>(
  dataRoot: string,
  sql: string,
  ...params: (string | null)[]
): T[] {
  const storage = join(dataRoot, 'v1', 'workspace-storage');
  const project = existsSync(storage)
    ? readdirSync(storage).find((name) => name.startsWith('work-'))
    : undefined;
  const file = project && join(storage, project, 'texra.db');
  if (!file || !existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** The files one of the launch form's lists holds, in order. */
const listed = (page: Page, group: 'Input' | 'Context' | 'Media') =>
  page
    .locator(`[role="list"][aria-label="${group} files"] [data-path]`)
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-path')),
    );

/** The launch form holds the reviser's setup: its agent and model, the
 *  draft as its input, and `form`'s instruction and context files. */
async function expectForm(
  page: Page,
  form: { readonly instruction: string; readonly context: readonly string[] },
): Promise<void> {
  await expect(page.locator('#composer-agent')).toHaveText('revise_validation');
  await expect(page.locator('#composer-model')).toHaveText(
    'GPT-6.1 Sol (high)',
  );
  await expect(page.locator('#composer-text')).toHaveValue(form.instruction);
  await expect.poll(() => listed(page, 'Input')).toEqual(['draft.tex']);
  await expect.poll(() => listed(page, 'Context')).toEqual(form.context);
  await expect.poll(() => listed(page, 'Media')).toEqual([]);
}

test.skip(process.platform === 'win32', 'no service runs on Windows yet');

test('a proposal edited in the app runs its child with the edits, Back leaves it waiting, and Run again relaunches the child', async () => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'texra-e2e-proposal-')));
  const home = join(root, 'home');
  const dataRoot = join(home, '.texra');
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const agents = join(dataRoot, 'v1', 'global-storage', 'custom_agents');
  mkdirSync(agents, { recursive: true });
  // The asking task: its scripted model calls `document_task` with this
  // input. The model is one the form lists, with an effort, so Run again
  // keeps both.
  const proposal = {
    agentName: 'revise_validation',
    model: 'openai/gpt-6.1-sol@high',
    inputFiles: ['draft.tex'],
    prompt: PROPOSED,
  };
  writeFileSync(
    join(agents, 'propose-validation.yaml'),
    `name: propose_validation\ndescription: Propose a document task over the draft.\ntools: [document_task]\n\nprompt: |\n  GOLDEN-APPROVAL document_task ${JSON.stringify(proposal)}\n`,
  );
  // The document task it proposes: one revision, which the scripted model
  // answers with a document.
  writeFileSync(
    join(agents, 'revise-validation.yaml'),
    'name: revise_validation\ndescription: Revise the draft as a document task.\n\nprompt: |\n  Revise the draft.\n\ntask:\n  requests:\n    - |\n      Output the revised documents.\n',
  );
  writeFileSync(join(work, 'draft.tex'), '\\section{Draft}\nOriginal text.\n');
  writeFileSync(join(work, 'macros.tex'), '\\newcommand{\\R}{\\mathbb{R}}\n');
  // A delegation starts only on a model with a key, and the service reads
  // keys from the project's .env, not from the CLI that starts the task.
  writeFileSync(
    join(work, '.env'),
    'OPENAI_API_KEY=texra-validation-fake-key\n',
  );
  const scripted = scriptedModel(work);
  const nextBuild = join(root, 'bin', 'texra-next.js');
  buildCli(nextBuild, { build: NEXT_BUILD });

  const rowsOf = <T>(runId: string, type: string): T[] =>
    storeRows<{ data: string }>(
      dataRoot,
      `SELECT e.data AS data FROM event e
       JOIN event_sequence s ON s.id = e.aggregate
       WHERE s.logical_id = ? AND e.type = ? ORDER BY e."commit"`,
      runId,
      type,
    ).map(({ data }) => JSON.parse(data) as T);
  /** The runs `parent` started, or the top-level runs for null. */
  const runsStartedBy = (parent: string | null): string[] =>
    storeRows<{ runId: string }>(
      dataRoot,
      `SELECT s.logical_id AS runId FROM event e
       JOIN event_sequence s ON s.id = e.aggregate
       WHERE e.type = 'run.start' AND json_extract(e.data, '$.parent.id') IS ?
       ORDER BY e."commit"`,
      parent,
    ).map(({ runId }) => runId);
  const outcomes = (runId: string) =>
    rowsOf<{ readonly outcome: string }>(runId, 'run.end').map(
      ({ outcome }) => outcome,
    );
  /** What the run runs with: its newest `run.config` row. */
  const runConfig = (runId: string) =>
    rowsOf<{ readonly config: Record<string, unknown> }>(
      runId,
      'run.config',
    ).at(-1)!;
  /** Path-free, so a rerun diffs clean. */
  const saveArtifact = (name: string, value: unknown) =>
    writeFileSync(
      test.info().outputPath(name),
      `${JSON.stringify(value, null, 2).replaceAll(root, '<root>')}\n`,
    );

  const pids = new Set<number>();
  try {
    const launched = await launchTexraApp({
      userDataPath: dataRoot,
      workspacePath: work,
      env: { HOME: home },
    });
    const { page } = launched;
    try {
      await dismissOnboarding(page);
      // The native file picker answers with the project's macros file.
      await launched.app.evaluate(
        ({ dialog }, picked) => {
          Object.assign(dialog, {
            showOpenDialog: () =>
              Promise.resolve({ canceled: false, filePaths: [picked] }),
          });
        },
        join(work, 'macros.tex'),
      );
      // The app's own service; a newer build's task retires it, and the
      // app reaches the newer one, which runs the scripted model.
      await expect
        .poll(() => serviceStatus(nextBuild, home).online, { timeout: 60_000 })
        .toBe(true);
      pids.add(serviceStatus(nextBuild, home).pid);
      const asking = JSON.parse(
        cli(
          nextBuild,
          home,
          [
            'tasks',
            'start',
            'propose_validation',
            '--model',
            'openai/gpt-6.1-sol',
            '--instruction',
            'Propose the revision',
            '--output-format',
            'json',
            '--cwd',
            work,
          ],
          scripted,
        ),
      ) as { readonly runId: string };
      pids.add(serviceStatus(nextBuild, home).pid);

      // The task asks to run the document task as proposed.
      type Opened = {
        readonly requestId: string;
        readonly payload: { readonly data: Record<string, unknown> };
      };
      await expect
        .poll(() => rowsOf(asking.runId, 'request.opened'), {
          timeout: 60_000,
        })
        .toHaveLength(1);
      const [opened] = rowsOf<Opened>(asking.runId, 'request.opened');
      expect(opened!.payload).toMatchObject({
        kind: 'proposal',
        data: {
          agent: 'revise_validation',
          model: 'openai/gpt-6.1-sol@high',
          instruction: PROPOSED,
          inputFiles: ['draft.tex'],
          contextFiles: [],
          mediaFiles: [],
          task: true,
        },
      });
      const askingRow = page
        .locator('.shell-project-runs run-tab')
        .filter({ has: page.locator(`[data-run="${asking.runId}"]`) });
      await expect(askingRow).toHaveCount(1, { timeout: 60_000 });
      await askingRow.click();
      const card = page.locator('proposal-request-panel');
      await expect(
        card.getByRole('heading', {
          name: 'Run revise_validation on GPT-6.1 Sol',
        }),
      ).toBeVisible({ timeout: 30_000 });
      const edit = card.getByRole('button', { name: 'Edit', exact: true });
      const back = page.locator('#editingBackButton');

      // Edit opens the launch form on the proposal as it would run.
      await edit.click();
      await expect(
        page.getByRole('heading', {
          name: 'Check revise_validation before it runs',
        }),
      ).toBeVisible();
      await expectForm(page, { instruction: PROPOSED, context: [] });
      await page.screenshot({
        path: test.info().outputPath('proposal-edit-form.png'),
      });

      // Back drops the form's change and answers nothing: the task still
      // waits on the proposal it made.
      await page.locator('#composer-text').fill('A change Back drops.');
      await back.click();
      await expect(back).toHaveCount(0);
      await expect(card.getByText(PROPOSED, { exact: true })).toBeVisible();
      await expect(
        card.getByRole('button', { name: 'Approve', exact: true }),
      ).toBeEnabled();
      await expect(
        askingRow.getByRole('button', {
          name: /^propose_validation · Status: Needs approval/,
        }),
      ).toBeVisible();
      expect(rowsOf(asking.runId, 'request.decided')).toHaveLength(0);
      await page.screenshot({
        path: test.info().outputPath('proposal-after-back.png'),
      });

      // Edit again: the form opens on the proposal, not on the change Back
      // dropped. Add a context file, rewrite the instruction, and approve.
      await edit.click();
      await expectForm(page, { instruction: PROPOSED, context: [] });
      await page.getByRole('button', { name: 'Add context files' }).click();
      await page.locator('#composer-text').fill(EDITED);
      await expectForm(page, { instruction: EDITED, context: ['macros.tex'] });
      await page.screenshot({
        path: test.info().outputPath('proposal-edited.png'),
      });
      await page.getByRole('button', { name: 'Approve', exact: true }).click();

      // One answer, the edited approval; the agent and the model stay the
      // proposal's.
      type Decided = {
        readonly requestId: string;
        readonly decision: Record<string, unknown>;
      };
      await expect
        .poll(() => rowsOf(asking.runId, 'request.decided'), {
          timeout: 60_000,
        })
        .toHaveLength(1);
      const [decided] = rowsOf<Decided>(asking.runId, 'request.decided');
      expect(decided!.requestId).toBe(opened!.requestId);
      expect(decided!.decision).toMatchObject({
        action: 'approve',
        agent: null,
        model: null,
        instruction: EDITED,
        inputFiles: ['draft.tex'],
        contextFiles: ['macros.tex'],
        mediaFiles: [],
      });

      // The child runs with the edits.
      await expect
        .poll(() => runsStartedBy(asking.runId), { timeout: 60_000 })
        .toHaveLength(1);
      const [child] = runsStartedBy(asking.runId);
      await expect
        .poll(() => outcomes(child!), { timeout: 120_000 })
        .toEqual(['completed']);
      const childConfig = runConfig(child!);
      expect(childConfig.config).toMatchObject({
        agent: 'revise_validation',
        agentSource: 'custom',
        model: 'openai/gpt-6.1-sol@high',
        instruction: EDITED,
        inputFiles: ['draft.tex'],
        contextFiles: ['macros.tex'],
        mediaFiles: [],
        workingDirectory: work,
        script: {
          kind: 'recipe',
          block: 'task',
          title: 'custom:revise_validation',
        },
      });
      saveArtifact('child-run-config.json', childConfig);

      // The approval went back to the asking task, which lists the child it
      // started and the child's revision, which the child started in turn.
      // Once the app shows both done, the child's row comes first.
      const started = page.getByRole('listitem', {
        name: 'Open revise_validation: Completed',
      });
      await expect(started).toHaveCount(2, { timeout: 60_000 });
      await started.first().click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'revise_validation',
      );
      await expect(
        page
          .getByRole('navigation', { name: 'Started by' })
          .getByRole('button'),
      ).toHaveText(['propose_validation']);

      // Run again… opens the form on the child's setup.
      await page
        .getByRole('button', { name: 'Task actions', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Run again…' }).click();
      await expect(
        page.getByRole('heading', { name: 'What would you like to do?' }),
      ).toBeVisible();
      await expectForm(page, { instruction: EDITED, context: ['macros.tex'] });
      await page.screenshot({
        path: test.info().outputPath('run-again-form.png'),
      });
      await page
        .getByRole('button', { name: 'Start task', exact: true })
        .click();

      // A new task runs the child's setup: the same recipe (which names the
      // agent's exact entry) on the same model, instruction and files, in
      // the project folder, where a form launch runs by default.
      await expect
        .poll(() => runsStartedBy(null), { timeout: 60_000 })
        .toHaveLength(2);
      const again = runsStartedBy(null).find((id) => id !== asking.runId)!;
      await expect
        .poll(() => outcomes(again), { timeout: 120_000 })
        .toEqual(['completed']);
      const againConfig = runConfig(again);
      saveArtifact('run-again-config.json', againConfig);
      const setup = ({ config }: typeof childConfig) => ({
        agentSource: config.agentSource,
        model: config.model,
        instruction: config.instruction,
        inputFiles: config.inputFiles,
        contextFiles: config.contextFiles,
        mediaFiles: config.mediaFiles,
        outputFiles: config.outputFiles,
        script: config.script,
        workingDirectory: config.workingDirectory ?? work,
      });
      expect(setup(againConfig)).toEqual(setup(childConfig));
      await page
        .locator('.shell-project-runs run-tab')
        .filter({ has: page.locator(`[data-run="${again}"]`) })
        .click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'revise_validation',
      );
      await expect(
        page.getByRole('navigation', { name: 'Started by' }),
      ).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath('run-again-run.png'),
      });

      // What the task asked for beside what the edited approval answered;
      // the ids differ on every run.
      const {
        runId: _run,
        requestId: _request,
        ...asked
      } = opened!.payload.data;
      saveArtifact('proposal-edit.json', {
        proposal: asked,
        approval: decided!.decision,
      });
    } finally {
      await closeTexraApp(launched);
    }
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
    cleanupDirectory(root);
  }
});
