// Standard library imports
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  findFilesFromPatterns,
  resolveHousekeepingTargets,
} from '@housekeeping/utils';
import {
  getAgentFirstNameChunk,
  legacyWorkflowOutputRoundRegex,
  legacyWorkflowOutputStem,
  midEraWorkflowOutputStem,
  normalizeLegacyModel,
} from '@shared/constants/legacyWorkflowOutput';
import { installPlatform } from '@test/support/setupPlatform';

describe('filename-era workflow output grammar', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(tmpdir(), 'texra-legacy-workflow-output-'),
    );
    await installPlatform({
      config: { 'texra.agent.rounds': 2 },
      workspacePath,
    });
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
  ])('preserves the XML-packing agent chunk for %s', (agent, expected) => {
    expect(getAgentFirstNameChunk(agent)).toBe(expected);
  });

  it('preserves the flat Save as copy filename', () => {
    const stem = legacyWorkflowOutputStem({
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
    expect(targets).not.toBeNull();
    if (!targets) {
      throw new Error('Expected valid housekeeping targets');
    }

    const found = findFilesFromPatterns(
      targets.inputDir,
      targets.filePatterns,
      ['.tex'],
    );
    expect(found).toHaveLength(matching.length);
    expect(found).toEqual(expect.arrayContaining(matching));
    for (const relativePath of nonMatching) {
      expect(found).not.toContain(relativePath);
    }
  });
});
