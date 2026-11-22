// An agent's proposal of a document program, edited in the desktop app
// before it runs (#14276). A task in the background service proposes the
// `edit` program, on the newer build's scripted model, and waits for the
// answer. The proposal card's Edit opens the launch form on the proposal,
// and Back returns to the asking task with the proposal still waiting. An
// edit that adds a context file and rewrites the instruction approves the
// child with both; the finished child's run offers no Run again.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Page } from '@playwright/test';

import { expect, test } from './electronApp.js';
import {
  NEXT_BUILD,
  buildCli,
  cli,
  scriptedModel,
  validationRun,
  serviceStatus,
} from './serviceFixture.js';
import { withStoreCopy } from './workspaceStorageFixture.js';

const PROPOSED = 'Tighten the prose.';
const EDITED = 'Tighten the prose; keep the macros.';

/** The rows `sql` selects from the store of the profile's project;
 *  none before the service creates it. */
function storeRows<T>(
  dataRoot: string,
  sql: string,
  ...params: (string | null)[]
): T[] {
  const storage = join(dataRoot, 'v1', 'workspace-storage');
  const project = existsSync(storage)
    ? readdirSync(storage).find((name) => name.startsWith('project-'))
    : undefined;
  if (!project || !existsSync(join(storage, project, 'texra.db'))) return [];
  // The service holds the store: its rows are read from a copy.
  return withStoreCopy(join(storage, project), (copy) => {
    const db = new DatabaseSync(join(copy, 'texra.db'), { readOnly: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  });
}

/** `rows`' entry at `index`, which a step before has waited for. */
function rowAt<T>(rows: readonly T[], index: number): T {
  const row = rows.at(index);
  if (row === undefined) throw new Error(`No row at ${index}.`);
  return row;
}

/** The files one of the launch form's lists holds, in order. */
const listed = (page: Page, group: 'Input' | 'Context' | 'Media') =>
  page
    .locator(`[role="list"][aria-label="${group} files"] [data-path]`)
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-path')),
    );

/** The launch form holds the program's setup: its model, the
 *  draft as its input, and `form`'s instruction and context files. */
async function expectForm(
  page: Page,
  form: { readonly instruction: string; readonly context: readonly string[] },
): Promise<void> {
  await expect(page.locator('#composer-model')).toHaveText(
    'GPT-6.1 Sol (high)',
  );
  await expect(page.locator('#composer-text')).toHaveValue(form.instruction);
  await expect.poll(() => listed(page, 'Input')).toEqual(['draft.tex']);
  await expect.poll(() => listed(page, 'Context')).toEqual(form.context);
  await expect.poll(() => listed(page, 'Media')).toEqual([]);
}

test.skip(process.platform === 'win32', 'no service runs on Windows yet');

test('a proposal edited in the app runs its child with the edits, and Back leaves it waiting', async ({
  profile,
  launch,
}) => {
  test.setTimeout(300_000);
  const { home, dataRoot, workspaceRoot: work } = profile;
  // The asking task: its scripted model calls `program` with this
  // input, on a model the form lists, with an effort.
  const proposal = {
    name: 'edit',
    model: 'openai/gpt-6.1-sol@high',
    inputFiles: ['draft.tex'],
    prompt: PROPOSED,
  };
  const asker = validationRun({
    label: 'propose_validation',
    system: `GOLDEN-APPROVAL program ${JSON.stringify(proposal)}`,
    tools: ['program'],
  });
  writeFileSync(join(work, 'draft.tex'), '\\section{Draft}\nOriginal text.\n');
  writeFileSync(join(work, 'macros.tex'), '\\newcommand{\\R}{\\mathbb{R}}\n');
  // A delegation starts only on a model with a key, and the service reads
  // keys from the project's .env, not from the CLI that starts the task.
  writeFileSync(
    join(work, '.env'),
    'OPENAI_API_KEY=texra-validation-fake-key\n',
  );
  const scripted = scriptedModel(work);
  const nextBuild = join(home, 'bin', 'texra-next.js');
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
    rowAt(
      rowsOf<{ readonly config: Record<string, unknown> }>(runId, 'run.config'),
      -1,
    );
  /** Path-free, so a rerun diffs clean. */
  const saveArtifact = (name: string, value: unknown) =>
    writeFileSync(
      test.info().outputPath(name),
      `${JSON.stringify(value, null, 2).replaceAll(home, '<home>')}\n`,
    );

  const launched = await launch(
    // The runner's own keys are blanked: the project's `.env` is the one
    // credential, so the launcher's onboarding answer comes from it.
    Object.fromEntries(
      Object.keys(process.env)
        .filter((name) => name.endsWith('_API_KEY'))
        .map((name) => [name, '']),
    ),
  );
  const { page } = launched;
  // The project's `.env` key counts as a credential: the launcher renders
  // and no "Connect a model" card replaces it (#14633).
  await page
    .locator('session-composer')
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 });
  await expect(page.locator('onboarding-welcome-card')).toHaveCount(0);
  await page.waitForFunction(
    () => document.body.dataset.desktopReady === 'true',
    undefined,
    { timeout: 10_000 },
  );
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
  const asking = JSON.parse(
    cli(
      nextBuild,
      home,
      [
        'tasks',
        'start',
        '--model',
        'openai/gpt-6.1-sol',
        '--instruction',
        'Propose the revision',
        '--approval-policy',
        'ask',
        '--output-format',
        'json',
        '--cwd',
        work,
      ],
      { ...scripted, ...asker },
    ),
  ) as { readonly runId: string };

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
  const opened = rowAt(rowsOf<Opened>(asking.runId, 'request.opened'), 0);
  expect(opened.payload).toMatchObject({
    kind: 'proposal',
    data: {
      label: 'edit',
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
      name: 'Run edit on GPT-6.1 Sol',
    }),
  ).toBeVisible({ timeout: 30_000 });
  const edit = card.getByRole('button', { name: 'Edit', exact: true });
  const back = page.locator('#editingBackButton');

  // Edit opens the launch form on the proposal as it would run.
  await edit.click();
  await expect(
    page.getByRole('heading', {
      name: 'Check edit before it runs',
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
      name: /^propose_validation · Status: Waiting on you/,
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
  const decided = rowAt(rowsOf<Decided>(asking.runId, 'request.decided'), 0);
  expect(decided.requestId).toBe(opened.requestId);
  // The agent and model are the proposal's, so the decision names neither.
  expect(decided.decision).toStrictEqual({
    action: 'approve',
    edit: {
      kind: 'proposal',
      instruction: EDITED,
      inputFiles: ['draft.tex'],
      contextFiles: ['macros.tex'],
      mediaFiles: [],
    },
  });

  // The child runs with the edits.
  await expect
    .poll(() => runsStartedBy(asking.runId), { timeout: 60_000 })
    .toHaveLength(1);
  const child = rowAt(runsStartedBy(asking.runId), 0);
  await expect
    .poll(() => outcomes(child), { timeout: 120_000 })
    .toEqual(['completed']);
  const childConfig = runConfig(child);
  expect(childConfig.config).toMatchObject({
    label: 'edit',
    model: 'openai/gpt-6.1-sol@high',
    instruction: EDITED,
    inputFiles: ['draft.tex'],
    contextFiles: ['macros.tex'],
    mediaFiles: [],
    workingDirectory: work,
    script: { kind: 'program', name: 'edit', args: {} },
  });
  saveArtifact('child-run-config.json', childConfig);

  // The approval went back to the asking task, which lists the child it
  // started and the child's two revisions, which the child started in
  // turn: each row is named by its run's label, so the program's revisions
  // are `Revision 1` and `Revision 2`. Once the app shows them done, the
  // child's row opens the child.
  const started = page.getByRole('listitem', {
    name: 'Open edit: Completed',
  });
  for (const name of [
    'Open edit: Completed',
    'Open Revision 1: Completed',
    'Open Revision 2: Completed',
  ])
    await expect(page.getByRole('listitem', { name })).toHaveCount(1, {
      timeout: 60_000,
    });
  await started.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('edit');
  await expect(
    page.getByRole('navigation', { name: 'Started by' }).getByRole('button'),
  ).toHaveText(['propose_validation']);
  // A program is not started from the launch form, so its run offers no
  // Run again.
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Run again…' })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: test.info().outputPath('program-run.png'),
  });

  // What the task asked for beside what the edited approval answered;
  // the ids differ on every run.
  const { runId: _run, requestId: _request, ...asked } = opened.payload.data;
  saveArtifact('proposal-edit.json', {
    proposal: asked,
    approval: decided.decision,
  });
});
