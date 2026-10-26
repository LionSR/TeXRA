/**
 * The PATH key a child process is handed.
 *
 * Windows spells the variable `Path`, and every one of these spawn sites
 * copies `process.env` into a plain object first — which keeps that spelling,
 * because `process.env` is case-insensitive there and an ordinary object is
 * not. The bug this pins is silent on the platform it is developed on: a
 * macOS run only ever sees `PATH`, so the duplicate-key case never arises
 * locally and only a Windows user sees the extension fail to apply.
 */
import { describe, expect, it } from 'vitest';
import { withExtendedPath } from '@texra-ai/harness/node';

/** The keys of `env` that name the PATH variable, whatever their casing. */
function pathKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => key.toLowerCase() === 'path');
}

describe('withExtendedPath', () => {
  // `commandEnv` merges caller overrides onto `process.env`, so on Windows an
  // override spelled `PATH` lands beside the platform's `Path` before this
  // runs. Writing one back would leave the other in place.
  it('collapses an override spelling onto the platform key', () => {
    const extended = withExtendedPath({ Path: '/from/env', PATH: '/override' });

    expect(pathKeys(extended)).toEqual(['Path']);
    expect(extended.Path).toContain('/override');
    expect(extended.Path).not.toContain('/from/env');
  });
});
