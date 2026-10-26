// Node.js imports
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { Effect, FileSystem } from 'effect';
import { describe, expect, it } from 'vitest';
import { subset } from 'semver';

import {
  buildDoctorReport,
  doctorExitCode,
  doctorNdjsonRecords,
  type DoctorReport,
  writeDoctorReport,
} from '@cli/runtime/doctor';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { TEXRA_CLI_SUPPORTED_NODE_RANGE } from '@cli/runtime/terminalRequirements';
import type { CliContext } from '@cli/runtime/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';

const context: CliContext = createTestCliContext({
  cwd: '/workspace',
  resourcesPath: '/resources',
});

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
} as const;

const availableModels = [
  {
    available: true,
    status: 'available',
    model: { value: 'deepseek/deepseek-v4-flash', label: 'DeepSeek T' },
  },
];

const allInstalledLatexProbe = {
  ...latexProbe,
  tools: latexProbe.tools.map((tool) => ({ ...tool, installed: true })),
};

const NDJSON_TS = '2026-05-18T00:00:00.000Z';

function captureDoctorStdout(
  writeContext: CliContext,
  report: DoctorReport,
): string {
  let stdout = '';
  const stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
    stdout += chunk;
  });

  try {
    writeDoctorReport(writeContext, report);
  } finally {
    stdoutSpy.mockRestore();
  }

  return stdout;
}

type DoctorProbes = Omit<
  Extract<Parameters<typeof buildDoctorReport>[1], { kind: 'ready' }>,
  'kind'
>;

// A signed-in report on supported Node with no model available and a partially
// installed LaTeX toolchain; tests override only the probes they care about.
// The builder is a program, so this helper is where it is run, over a
// filesystem where every probed path is an accessible directory.
function buildReport(
  probes: Partial<DoctorProbes> = {},
  reportContext: CliContext = context,
  fileSystem: Partial<FileSystem.FileSystem> = {},
): Promise<DoctorReport> {
  return Effect.runPromise(
    buildDoctorReport(reportContext, {
      kind: 'ready',
      nodeVersion: '24.15.0',
      modelAccessList: Effect.succeed([]),
      latexToolchain: Effect.succeed(latexProbe),
      usageLoggingOptOut: Effect.succeed(null),
      ...probes,
    }).pipe(
      Effect.provide([
        FileSystem.layerNoop({
          stat: () =>
            Effect.succeed({ type: 'Directory' } as FileSystem.File.Info),
          access: () => Effect.void,
          ...fileSystem,
        }),
        nodeSpawnerLayer,
      ]),
    ),
  );
}

// The same report with one available model and a fully installed LaTeX
// toolchain; only the optional context varies.
function buildReadyReport(
  reportContext: CliContext = context,
): Promise<DoctorReport> {
  return buildReport(
    {
      modelAccessList: Effect.succeed(availableModels),
      latexToolchain: Effect.succeed(allInstalledLatexProbe),
    },
    reportContext,
  );
}

function checkById(
  report: DoctorReport,
  id: string,
): DoctorReport['checks'][number] | undefined {
  return report.checks.find((check) => check.id === id);
}

describe('CLI doctor', () => {
  it('reports failed checks and exits nonzero', async () => {
    const report = await buildReport({
      nodeVersion: '20.1.0',
    });

    expect(report.ok).toBe(false);
    expect(checkById(report, 'node')?.status).toBe('fail');
    expect(checkById(report, 'latex.latexmk')?.status).toBe('fail');
    expect(doctorExitCode(report)).toBe(CliExitCode.ModelOrNetworkError);
  });

  it('asks only for read access on the packaged resources directory', async () => {
    // `sudo npm install -g` leaves the package root-owned and unwritable,
    // which is the norm on Linux and WSL; the CLI only ever reads from it.
    const writable = new Map<string, boolean | undefined>();
    const report = await buildReport({}, context, {
      access: (filePath, options) => {
        writable.set(filePath, options?.writable);
        return Effect.void;
      },
    });

    expect(checkById(report, 'resources')?.status).toBe('pass');
    expect(writable.get('/resources')).toBe(false);
    expect(writable.get('/workspace')).toBe(true);
  });

  it('keeps the supported Node range inside the bundled undici requirement', () => {
    const require = createRequire(import.meta.url);
    const undiciNodeRange = (
      require('undici/package.json') as { engines: { node: string } }
    ).engines.node;
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const publishedRanges = [
      TEXRA_CLI_SUPPORTED_NODE_RANGE,
      ...['packages/cli', 'packages/harness'].map(
        (packageDir) =>
          (
            JSON.parse(
              readFileSync(join(repoRoot, packageDir, 'package.json'), 'utf8'),
            ) as { engines: { node: string } }
          ).engines.node,
      ),
    ];

    for (const range of publishedRanges) {
      expect(
        subset(range, undiciNodeRange),
        `${range} must satisfy undici's engines.node ${undiciNodeRange}`,
      ).toBe(true);
    }
  });

  it('redacts email-like values in check messages and hints', () => {
    const report: DoctorReport = {
      ok: true,
      checks: [
        {
          id: 'config',
          name: 'Config',
          status: 'warn',
          message: 'Workspace config references owner@example.edu.',
          hint: 'Ask admin@example.edu to update it.',
        },
      ],
    };

    const text = captureDoctorStdout(context, report);
    const records = doctorNdjsonRecords(report, NDJSON_TS);

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

  it('emits stable ndjson record kinds', async () => {
    const report = await buildReadyReport();

    const records = doctorNdjsonRecords(report, NDJSON_TS);

    expect(records.at(0)).toMatchObject({
      kind: 'doctor-check',
      ts: NDJSON_TS,
      id: 'node',
    });
    expect(records.at(-1)).toEqual({
      kind: 'doctor-summary',
      ts: NDJSON_TS,
      ok: true,
    });
    expect(doctorExitCode(report)).toBe(CliExitCode.Success);
  });
});
