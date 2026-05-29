import { describe, expect, it } from 'vitest';

import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from '@cli/commands/_helpers/modelArg';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  type CliConfigValues,
} from '@cli/runtime/cliConfig';
import type { CliContext } from '@cli/runtime/cliContext';

const KNOWN_MODEL = 'gpt5';
const OTHER_MODEL = 'claudeSonnet';

function makeContext(partial: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp',
    colorEnabled: false,
    mode: 'oneshot',
    outputFormat: 'text',
    stderrIsTty: false,
    quietLogs: false,
    ...partial,
  } as CliContext;
}

const runConfig = (model: string): CliConfigValues => ({ run: { model } });

describe('resolveCliRunModel precedence', () => {
  it('prefers the explicit model over env and config', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(resolveCliRunModel(context, KNOWN_MODEL, 'run')).toBe(KNOWN_MODEL);
  });

  it('falls back to env when no explicit model is given', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(resolveCliRunModel(context, undefined, 'run')).toBe(OTHER_MODEL);
  });

  it('uses the configured model when no explicit or env model', () => {
    const context = makeContext({ cliConfig: runConfig('deepseekR') });
    expect(resolveCliRunModel(context, undefined, 'run')).toBe('deepseekR');
  });

  it('reads the role-specific config section', () => {
    const context = makeContext({
      cliConfig: { chat: { model: OTHER_MODEL }, run: { model: 'deepseekR' } },
    });
    expect(resolveCliRunModel(context, undefined, 'chat')).toBe(OTHER_MODEL);
    expect(resolveCliRunModel(context, undefined, 'run')).toBe('deepseekR');
  });

  it('falls back to the builtin default when nothing else is set', () => {
    expect(resolveCliRunModel(makeContext(), undefined, 'run')).toBe(
      CLI_BUILTIN_DEFAULT_MODEL,
    );
  });
});

describe('buildHeadlessRunContext', () => {
  it('sets the helper model, quiet logs, and enables progress for text output', () => {
    const context = makeContext({ outputFormat: 'text', quietLogs: false });
    const runContext = buildHeadlessRunContext(context, KNOWN_MODEL);
    expect(runContext.helperModel).toBe(KNOWN_MODEL);
    expect(runContext.quietLogs).toBe(true);
    expect(runContext.renderRunProgress).toBe(true);
  });

  it('disables run progress for non-text output formats', () => {
    const context = makeContext({ outputFormat: 'json' });
    const runContext = buildHeadlessRunContext(context, KNOWN_MODEL);
    expect(runContext.renderRunProgress).toBe(false);
  });
});
