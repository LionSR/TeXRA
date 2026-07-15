import { describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';

import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  buildDoctorReport,
  doctorExitCode,
  doctorNdjsonRecords,
  formatDoctorText,
  type DoctorReport,
  writeDoctorReport,
} from '@cli/runtime/doctor';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliContext } from '@cli/runtime/cliContext';

const context: CliContext = createTestCliContext({
  cwd: '/workspace',
  resourcesPath: '/resources',
});

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

const availableModels = [
  {
    available: true,
    status: 'available',
    model: { value: 'deepseekT', label: 'DeepSeek T' },
  },
];

const allInstalledLatexProbe = {
  ...latexProbe,
  tools: latexProbe.tools.map((tool) => ({ ...tool, installed: true })),
};

const healthyNodeReport: DoctorReport = {
  ok: true,
  checks: [
    {
      id: 'node',
      name: 'Node.js',
      status: 'pass',
      message: 'Node 24.15.0',
    },
  ],
};

function captureDoctorStdout(
  writeContext: CliContext,
  report: DoctorReport,
): string {
  let stdout = '';
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stdout += String(chunk);
      const cb = rest.find((arg) => typeof arg === 'function') as
        ((error?: Error | null) => void) | undefined;
      cb?.(null);
      return true;
    }) as unknown as ReturnType<typeof vi.spyOn>;

  try {
    writeDoctorReport(writeContext, report);
  } finally {
    stdoutSpy.mockRestore();
  }

  return stdout;
}

async function buildNodeVersionReport(
  nodeVersion: string,
): Promise<DoctorReport> {
  return buildDoctorReport(context, {
    nodeVersion,
    authProfile: async () => ({ authenticated: true }),
    modelAccessList: async () => [],
    latexToolchain: async () => latexProbe,
    pathStat: async () => directory,
    pathAccess: async () => undefined,
  });
}

// A signed-in report on supported Node with one available model and a fully
// installed LaTeX toolchain; only the auth profile (and optional context) vary.
function buildReadyReport(
  authProfile: NonNullable<
    Parameters<typeof buildDoctorReport>[1]
  >['authProfile'],
  reportContext: CliContext = context,
): Promise<DoctorReport> {
  return buildDoctorReport(reportContext, {
    nodeVersion: '24.15.0',
    authProfile,
    modelAccessList: async () => availableModels as never,
    latexToolchain: async () => allInstalledLatexProbe,
    pathStat: async () => directory,
    pathAccess: async () => undefined,
  });
}

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

  it('matches the published Node engine range', async () => {
    const cases: Array<[string, 'pass' | 'fail']> = [
      ['21.9.9', 'fail'],
      ['22.8.9', 'fail'],
      ['22.9.0', 'pass'],
      ['v22.9.0', 'pass'],
      ['23.0.0', 'pass'],
      ['24.15.0', 'pass'],
      ['26.0.0', 'pass'],
    ];

    for (const [nodeVersion, expected] of cases) {
      const report = await buildNodeVersionReport(nodeVersion);
      expect(report.checks.find((check) => check.id === 'node')?.status).toBe(
        expected,
      );
    }

    const unsupportedRelease = await buildNodeVersionReport('21.0.0');
    expect(
      unsupportedRelease.checks.find((check) => check.id === 'node')?.message,
    ).toBe('Node 21.0.0 is outside the supported range.');
    expect(
      unsupportedRelease.checks.find((check) => check.id === 'node')?.hint,
    ).toBe('Install Node >=22.9.0 before running TeXRA CLI.');
  });

  it('keeps human-readable hints in text output', async () => {
    const report = await buildDoctorReport(context, {
      nodeVersion: '24.15.0',
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
        '     Run `texra models list --all` to inspect access, sign in with `texra login`, or add a provider API key with `texra setup`.',
      ].join('\n'),
    );
    expect(text).not.toContain('/api personal');
    expect(text).toContain('SKIP Config: No workspace CLI config file found.');
  });

  it('reports loaded workspace config warnings', async () => {
    const report = await buildReadyReport(
      async () => ({ authenticated: true }),
      {
        ...context,
        configFilePath: '/workspace/.texra/config.json',
        configWarnings: ['Ignoring invalid model.'],
      },
    );

    expect(
      report.checks.map((check) => [check.id, check.status]),
    ).toContainEqual(['config', 'warn']);
    expect(formatDoctorText(report)).toContain('Ignoring invalid model.');
  });

  it('shows email account labels plainly in text output', async () => {
    const report = await buildReadyReport(async () => ({
      authenticated: true,
      accountLabel: 'user@example.edu',
      tier: 'Max',
    }));

    const text = formatDoctorText(report);
    const authCheck = report.checks.find((check) => check.id === 'auth');
    const records = doctorNdjsonRecords(report, '2026-05-18T00:00:00.000Z');

    expect(authCheck?.message).toContain('user@example.edu');
    expect(text).toContain('Signed in as user@example.edu, Max.');
    expect(records).toContainEqual(
      expect.objectContaining({
        id: 'auth',
        message: 'Signed in as user@example.edu, Max.',
      }),
    );
  });

  it('redacts email-like values outside the auth account message', () => {
    const report: DoctorReport = {
      ok: false,
      checks: [
        {
          id: 'auth',
          name: 'Included access',
          status: 'pass',
          message: 'Signed in as user@example.edu.',
        },
        {
          id: 'config',
          name: 'Config',
          status: 'warn',
          message: 'Workspace config references owner@example.edu.',
          hint: 'Ask admin@example.edu to update it.',
        },
      ],
    };

    const text = formatDoctorText(report);
    const records = doctorNdjsonRecords(report, '2026-05-18T00:00:00.000Z');

    expect(text).toContain('Signed in as user@example.edu.');
    expect(text).toContain('Workspace config references o***@e***.edu.');
    expect(text).toContain('Ask a***@e***.edu to update it.');
    expect(text).not.toContain('owner@example.edu');
    expect(text).not.toContain('admin@example.edu');
    expect(records).toContainEqual(
      expect.objectContaining({
        id: 'config',
        message: 'Workspace config references owner@example.edu.',
        hint: 'Ask admin@example.edu to update it.',
      }),
    );
  });

  it('keeps non-email account labels readable in text output', async () => {
    const report = await buildReadyReport(async () => ({
      authenticated: true,
      accountLabel: 'team@internal',
    }));

    const text = formatDoctorText(report);
    const records = doctorNdjsonRecords(report, '2026-05-18T00:00:00.000Z');

    expect(text).toContain('Signed in as team@internal.');
    expect(records).toContainEqual(
      expect.objectContaining({
        id: 'auth',
        message: 'Signed in as team@internal.',
      }),
    );
  });

  it('falls back to unknown for an empty auth account label', async () => {
    const report = await buildReadyReport(async () => ({
      authenticated: true,
      accountLabel: '',
    }));

    expect(report.checks.find((check) => check.id === 'auth')?.message).toBe(
      'Signed in as unknown.',
    );
  });

  it('emits stable ndjson record kinds', async () => {
    const report = await buildReadyReport(async () => ({
      authenticated: true,
      accountLabel: 'Ada',
      tier: 'pro',
    }));

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

  it('does not color successful text output when stdout is piped', () => {
    const stdout = captureDoctorStdout(
      {
        ...context,
        colorEnabled: true,
        stdoutIsTty: false,
        stderrIsTty: true,
        stdoutColorEnabled: false,
        stderrColorEnabled: true,
      },
      healthyNodeReport,
    );

    expect(stdout).toContain('PASS Node.js: Node 24.15.0');
    expect(stdout).toBe(stripAnsi(stdout));
  });

  it('keeps successful text output colored when only stderr is redirected', () => {
    const stdout = captureDoctorStdout(
      {
        ...context,
        colorEnabled: false,
        stdoutIsTty: true,
        stderrIsTty: false,
        stdoutColorEnabled: true,
        stderrColorEnabled: false,
      },
      healthyNodeReport,
    );

    expect(stripAnsi(stdout)).toContain('PASS Node.js: Node 24.15.0');
    expect(stdout).not.toBe(stripAnsi(stdout));
  });
});
