import { describe, expect, it } from 'vitest';

import {
  buildDoctorReport,
  doctorExitCode,
  doctorNdjsonRecords,
  formatDoctorText,
} from '@cli/runtime/doctor';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliContext } from '@cli/runtime/cliContext';

const context: CliContext = {
  cwd: '/workspace',
  mode: 'headless',
  outputFormat: 'text',
  approvalPolicy: 'never',
  colorEnabled: false,
  version: '0.0.0',
  resourcesPath: '/resources',
};

const directory = {
  isDirectory: () => true,
};

const latexProbe = {
  tools: [
    {
      name: 'latexmk',
      installed: false,
      required: true,
      purpose: 'LaTeX build orchestration',
    },
    {
      name: 'pdflatex',
      installed: true,
      required: true,
      purpose: 'PDFLaTeX compiler',
    },
  ],
  hasCompiler: true,
  hasBibliographyTool: false,
  hasLatexmk: false,
} as const;

describe('CLI doctor', () => {
  it('reports failed checks and exits nonzero', async () => {
    const report = await buildDoctorReport(context, {
      nodeVersion: '20.1.0',
      authProfile: async () => ({ authenticated: false }),
      modelAccessList: async () => [],
      latexToolchain: async () => latexProbe,
      pathStat: async () => directory,
      pathAccess: async () => undefined,
    });

    expect(report.ok).toBe(false);
    expect(
      report.checks.map((check) => [check.id, check.status]),
    ).toContainEqual(['node', 'fail']);
    expect(
      report.checks.map((check) => [check.id, check.status]),
    ).toContainEqual(['latex.latexmk', 'fail']);
    expect(doctorExitCode(report)).toBe(CliExitCode.ModelOrNetworkError);
  });

  it('keeps human-readable hints in text output', async () => {
    const report = await buildDoctorReport(context, {
      nodeVersion: '24.0.0',
      authProfile: async () => ({ authenticated: false }),
      modelAccessList: async () => [],
      latexToolchain: async () => latexProbe,
      pathStat: async () => directory,
      pathAccess: async () => undefined,
    });

    const text = formatDoctorText(report);

    expect(text).toContain(
      [
        'FAIL Models: No model is currently available.',
        '     Run `texra models list --all` to inspect access, sign in with `texra login`, or configure a provider API key.',
      ].join('\n'),
    );
    expect(text).not.toContain('/api personal');
    expect(text).toContain('SKIP Config: No workspace CLI config file found.');
  });

  it('reports loaded workspace config warnings', async () => {
    const report = await buildDoctorReport(
      {
        ...context,
        configFilePath: '/workspace/.texra/config.json',
        configWarnings: ['Ignoring invalid model.'],
      },
      {
        nodeVersion: '24.0.0',
        authProfile: async () => ({ authenticated: true }),
        modelAccessList: async () =>
          [
            {
              available: true,
              status: 'available',
              model: { value: 'deepseekT', label: 'DeepSeek T' },
            },
          ] as never,
        latexToolchain: async () => ({
          ...latexProbe,
          tools: latexProbe.tools.map((tool) => ({
            ...tool,
            installed: true,
          })),
        }),
        pathStat: async () => directory,
        pathAccess: async () => undefined,
      },
    );

    expect(
      report.checks.map((check) => [check.id, check.status]),
    ).toContainEqual(['config', 'warn']);
    expect(formatDoctorText(report)).toContain('Ignoring invalid model.');
  });

  it('redacts email account labels in text output', async () => {
    const report = await buildDoctorReport(context, {
      nodeVersion: '24.0.0',
      authProfile: async () => ({
        authenticated: true,
        accountLabel: 'user@example.edu',
        tier: 'Max',
      }),
      modelAccessList: async () =>
        [
          {
            available: true,
            status: 'available',
            model: { value: 'deepseekT', label: 'DeepSeek T' },
          },
        ] as never,
      latexToolchain: async () => ({
        ...latexProbe,
        tools: latexProbe.tools.map((tool) => ({ ...tool, installed: true })),
      }),
      pathStat: async () => directory,
      pathAccess: async () => undefined,
    });

    const text = formatDoctorText(report);
    const authCheck = report.checks.find((check) => check.id === 'auth');
    const records = doctorNdjsonRecords(report, '2026-05-18T00:00:00.000Z');

    expect(authCheck?.message).toContain('user@example.edu');
    expect(text).toContain('Stored sign-in found for u***@e***.edu, Max.');
    expect(text).not.toContain('user@example.edu');
    expect(records).toContainEqual(
      expect.objectContaining({
        id: 'auth',
        message: 'Stored sign-in found for user@example.edu, Max.',
      }),
    );
  });

  it('keeps non-email account labels readable in text output', async () => {
    const report = await buildDoctorReport(context, {
      nodeVersion: '24.0.0',
      authProfile: async () => ({
        authenticated: true,
        accountLabel: 'team@internal',
      }),
      modelAccessList: async () =>
        [
          {
            available: true,
            status: 'available',
            model: { value: 'deepseekT', label: 'DeepSeek T' },
          },
        ] as never,
      latexToolchain: async () => ({
        ...latexProbe,
        tools: latexProbe.tools.map((tool) => ({ ...tool, installed: true })),
      }),
      pathStat: async () => directory,
      pathAccess: async () => undefined,
    });

    const text = formatDoctorText(report);
    const records = doctorNdjsonRecords(report, '2026-05-18T00:00:00.000Z');

    expect(text).toContain('Stored sign-in found for team@internal.');
    expect(records).toContainEqual(
      expect.objectContaining({
        id: 'auth',
        message: 'Stored sign-in found for team@internal.',
      }),
    );
  });

  it('emits stable ndjson record kinds', async () => {
    const report = await buildDoctorReport(context, {
      nodeVersion: '24.0.0',
      authProfile: async () => ({
        authenticated: true,
        accountLabel: 'Ada',
        tier: 'pro',
      }),
      modelAccessList: async () =>
        [
          {
            available: true,
            status: 'available',
            model: { value: 'deepseekT', label: 'DeepSeek T' },
          },
        ] as never,
      latexToolchain: async () => ({
        ...latexProbe,
        tools: latexProbe.tools.map((tool) => ({ ...tool, installed: true })),
      }),
      pathStat: async () => directory,
      pathAccess: async () => undefined,
    });

    const records = doctorNdjsonRecords(report, '2026-05-18T00:00:00.000Z');

    expect(records.at(0)).toMatchObject({
      kind: 'doctor-check',
      ts: '2026-05-18T00:00:00.000Z',
      id: 'node',
    });
    expect(records.at(-1)).toEqual({
      kind: 'doctor-summary',
      ts: '2026-05-18T00:00:00.000Z',
      ok: true,
    });
    expect(doctorExitCode(report)).toBe(CliExitCode.Success);
  });
});
