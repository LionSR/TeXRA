/**
 * The background service as the service-backed specs drive it: a CLI
 * bundle of this tree, one command of it against a scratch home, the status
 * the service reports, and the switches that run a newer build's tasks on
 * the scripted validation model.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VALIDATION_FLAG,
  VALIDATION_FLAG_CONTENT,
  VALIDATION_SCENARIOS,
  VALIDATION_SWITCH,
} from '../../../cli/src/runtime/models/validationSwitch';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CLI_ROOT = join(REPO_ROOT, 'packages', 'cli');

/** The build a newer CLI stamps: its service retires the app's. */
export const NEXT_BUILD = '999.0.0';

interface ServiceStatus {
  readonly pid: number;
  readonly version: string;
  readonly clients: number;
  readonly online: boolean;
}

/** A CLI bundle of this tree, stamped as `build` when one is named; a
 *  newer build carries the scripted validation model. `window` bundles the
 *  validator's editor-less window (scripts/service-host-harness.ts)
 *  instead. The bundle finds its resources beside its bin directory. */
export function buildCli(
  outfile: string,
  { build, window = false }: { build?: string; window?: boolean } = {},
): void {
  const result = spawnSync(
    process.execPath,
    [
      join(CLI_ROOT, 'scripts', 'build-bundle.mjs'),
      ...(window ? ['--host-harness'] : []),
    ],
    {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        TEXRA_CLI_BUNDLE_OUTFILE: outfile,
        ...(build && {
          TEXRA_BUILD_VERSION: build,
          TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
        }),
      },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`CLI build failed:\n${result.stdout}\n${result.stderr}`);
  const resources = join(dirname(outfile), '..', 'resources');
  if (!existsSync(resources))
    symlinkSync(
      join(REPO_ROOT, 'packages', 'extension', 'resources'),
      resources,
    );
}

/** `texra <args>` of `binary` with `home` as its home; its stdout. */
export function cli(
  binary: string,
  home: string,
  args: readonly string[],
  env: Record<string, string> = {},
): string {
  const result = spawnSync(process.execPath, [binary, ...args], {
    env: {
      ...process.env,
      HOME: home,
      CI: '1',
      TEXRA_NO_TELEMETRY: '1',
      ...env,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(
      `texra ${args.join(' ')} exited ${result.status}:\n${result.stderr}`,
    );
  return result.stdout;
}

/** The service of `home`, as `texra service status` reports it. */
export const serviceStatus = (binary: string, home: string): ServiceStatus =>
  JSON.parse(
    cli(binary, home, ['service', 'status', '--output-format', 'json']),
  ) as ServiceStatus;

/** What runs a newer build's tasks on its scripted model: the switches,
 *  and the flag file the model checks, written into `dir`. A held call's
 *  release file goes beside it. */
export function scriptedModel(dir: string): Record<string, string> {
  const flag = join(dir, 'texra-validation.flag');
  writeFileSync(flag, VALIDATION_FLAG_CONTENT);
  return {
    [VALIDATION_SWITCH]: '1',
    [VALIDATION_FLAG]: flag,
    [VALIDATION_SCENARIOS.golden]: '1',
    OPENAI_API_KEY: 'texra-validation-fake-key',
  };
}
