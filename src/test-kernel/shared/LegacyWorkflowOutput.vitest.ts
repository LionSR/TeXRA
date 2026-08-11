// Node imports
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { runCleanSingle } from '@housekeeping/clean';
import { runPack } from '@housekeeping/pack';
import {
  findFilesFromPatterns,
  resolveHousekeepingTargets,
} from '@housekeeping/utils';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import {
  legacyWorkflowOutputRoundRegex,
  midEraWorkflowOutputStem,
  normalizeLegacyModel,
  workflowOutputCopyStem,
} from '@shared/constants/workflowOutput';
import { installPlatform } from '@test/support/setupPlatform';

describe('filename-era workflow output grammar', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(tmpdir(), 'texra-legacy-workflow-output-'),
    );
    await installPlatform(
      {
        config: { 'texra.agent.rounds': 2 },
        workspacePath,
      },
      { fs: nodeFilesystem },
    );
  });

  afterEach(async () => {
    await installPlatform();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('preserves the dotted-model normalization used by flat filenames', () => {
    expect(normalizeLegacyModel('gpt-4.5.preview')).toBe('gpt-45preview');
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

  it('preserves the flat Save as copy filename', () => {
    const stem = workflowOutputCopyStem({
      base: 'paper[1]',
      agent: 'builtInWorkflow:write-polish',
      model: 'gpt-4.5',
      round: 12,
    });

    expect(`${stem}.tex`).toBe('paper[1]_polish_r12_gpt-45.tex');
  });

  it('preserves the mid-era workspace filename', () => {
    expect(
      midEraWorkflowOutputStem({
        base: 'paper',
        agent: 'custom:polish_long',
        model: 'gpt-4.5',
      }),
    ).toBe('paper_polish_long_gpt-4.5');
  });

  it('escapes filename tokens while preserving the unanchored round match', () => {
    const pattern = legacyWorkflowOutputRoundRegex(
      'paper[1]',
      'builtInWorkflow:write-polish',
      'gpt-4.5',
    );

    expect(pattern.exec('prefix-paper[1]_polish_r12_gpt-45-suffix')?.[1]).toBe(
      '12',
    );
    expect(pattern.test('paper1_polish_r12_gpt-45')).toBe(false);
  });

  it('matches flat and mid-era housekeeping files without matching siblings', async () => {
    await mkdir(path.join(workspacePath, 'r1'));
    const matching = [
      'paper_polish_r0_gpt-45.tex',
      'paper_polish_r0_gpt-45_diff.tex',
      'paper_polish_r0_full_gpt-45.tex',
      'r1/paper_polish_long_gpt-4.5.tex',
    ];
    const nonMatching = [
      'paper2_polish_r0_gpt-45.tex',
      'r1/paper2_polish_long_gpt-4.5.tex',
    ];
    for (const relativePath of [...matching, ...nonMatching]) {
      await writeFile(path.join(workspacePath, relativePath), 'fixture');
    }

    const targets = resolveHousekeepingTargets(
      'gpt-4.5',
      'paper.tex',
      'custom:polish_long',
    );
    if (!targets) {
      throw new Error('Expected valid housekeeping targets');
    }

    const found = new Set<string>();
    for await (const file of findFilesFromPatterns(
      targets.inputDir,
      targets.filePatterns,
      ['.tex'],
    )) {
      found.add(file);
    }
    expect(found.size).toBe(matching.length);
    expect([...found]).toEqual(expect.arrayContaining(matching));
    for (const relativePath of nonMatching) {
      expect(found).not.toContain(relativePath);
    }
  });

  it('packs a flat XML round output written for a dotted model', async () => {
    // The on-disk name normalizes the model's dots, so a packer that spells
    // the raw model silently leaves the file behind.
    const xmlRelativePath = 'paper_polish_r0_gpt-45.xml';
    await writeFile(path.join(workspacePath, 'paper.tex'), 'source');
    await writeFile(path.join(workspacePath, 'paper2.tex'), 'source');
    await writeFile(path.join(workspacePath, xmlRelativePath), '<xml/>');

    const result = await runPack('gpt-4.5', 'paper.tex', 'custom:polish_long', [
      'paper2.tex',
    ]);

    if (result.status !== 'success' || result.outputFolder === undefined) {
      throw new Error(`Expected a successful pack, got ${result.status}`);
    }
    await expect(
      access(path.join(workspacePath, xmlRelativePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(path.join(workspacePath, result.outputFolder, xmlRelativePath)),
    ).resolves.toBeUndefined();
  });

  it('deletes a file matched by overlapping legacy patterns only once', async () => {
    const inputPath = path.join(workspacePath, 'paper.tex');
    const relativePath = 'paper_polish_r0_full_gpt-45.tex';
    const absolutePath = path.join(workspacePath, relativePath);
    await writeFile(inputPath, 'source');
    await writeFile(absolutePath, 'fixture');

    await expect(
      runCleanSingle('gpt-4.5', 'paper.tex', 'custom:polish_long'),
    ).resolves.toEqual({ status: 'success' });
    await expect(access(absolutePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(inputPath)).resolves.toBeUndefined();
  });
});
