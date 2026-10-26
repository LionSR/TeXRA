import * as path from 'node:path';

import { Cause, Effect, Exit, FileSystem, PlatformError } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { getGitignoreMatcher } from '@tools/gitignore';

/** The workspace root each call names, as its caller's `WorkspaceFs` would. */
const WORKSPACE = '/workspace';

describe('getGitignoreMatcher', () => {
  // An unreadable policy must fail the call, not read as "nothing ignored":
  // failing open would list and attach files the workspace ignores.
  it.effect('rejects when a workspace ignore policy cannot be read', () => {
    const filePath = path.join(WORKSPACE, '.gitignore');
    const failure = PlatformError.systemError({
      _tag: 'PermissionDenied',
      module: 'FileSystem',
      method: 'readFileString',
      pathOrDescriptor: filePath,
    });
    const policyFiles = FileSystem.layerNoop({
      readFileString: (p: string) =>
        p === filePath
          ? Effect.fail(failure)
          : Effect.fail(
              PlatformError.systemError({
                _tag: 'NotFound',
                module: 'FileSystem',
                method: 'readFileString',
                pathOrDescriptor: p,
              }),
            ),
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(getGitignoreMatcher(WORKSPACE));
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toBe(failure);
    }).pipe(Effect.provide(policyFiles));
  });
});
