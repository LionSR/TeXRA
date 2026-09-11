// Node imports
import { access, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { runPackSingle } from '@housekeeping/pack';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { workflowOutputCopyStem } from '@shared/constants/workflowOutput';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('Save-as-copy stem and workspace pack', () => {
  const tempDirs = useTempDirs();
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await makeTempDir(
      'texra-legacy-workflow-output-',
      tempDirs,
    );
    await installPlatform({ workspacePath }, { fs: nodeFilesystem });
  });

  afterEach(async () => {
    await installPlatform();
  });

  it.each([
    ['builtInWorkflow:write-polish', 'polish'],
    ['custom:alpha_beta', 'alpha'],
    ['remote:alpha-beta', 'alpha'],
    ['vendor:alpha_beta', 'vendor:alpha'],
  ])('preserves the agent chunk in the stem for %s', (agent, expected) => {
    expect(
      workflowOutputCopyStem({
        base: 'paper',
        agent,
        model: 'gpt-4',
        round: 0,
      }),
    ).toBe(`paper_${expected}_r0_gpt-4`);
  });

  it("packs the source's own files and leaves Save-as-copy files and the source's .bib/.bak alone", async () => {
    const saveAsCopy = 'paper_polish_r0_gpt-4.tex';
    for (const name of [
      'paper.tex',
      'paper.pdf',
      'paper.bib',
      'paper.bak1',
      'paper.aux',
      saveAsCopy,
    ]) {
      await writeFile(path.join(workspacePath, name), 'fixture');
    }

    const result = await runPackSingle(
      'gpt-4',
      'paper.tex',
      'custom:polish_long',
    );

    if (result.status !== 'success' || result.outputFolder === undefined) {
      throw new Error(`Expected a successful pack, got ${result.status}`);
    }
    const outputFolder = path.join(workspacePath, result.outputFolder);
    expect(path.basename(result.outputFolder)).not.toContain(':');
    await expect(
      access(path.join(outputFolder, 'paper.pdf')),
    ).resolves.toBeUndefined();
    for (const kept of ['paper.bib', 'paper.bak1', saveAsCopy]) {
      await expect(
        access(path.join(workspacePath, kept)),
      ).resolves.toBeUndefined();
    }
    await expect(
      access(path.join(outputFolder, saveAsCopy)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(path.join(workspacePath, 'paper.aux')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
