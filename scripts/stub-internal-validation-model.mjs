// esbuild plugin that keeps the package-validation model
// (`src/agent/runtime/run/validationModel.ts`) out of a shipped bundle. Every
// import that resolves to that file, through the `@agent/*` alias or a
// relative path, loads a stand-in instead: its gate is an Effect of `false`
// (matching the real module's Effect-returning gate) and its canned model
// throws. The CLI, desktop main and extension builds all install it, so no
// shipped bundle carries the canned output or a gate the environment can open.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const realModule = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/agent/runtime/run/validationModel.ts',
);

const STUB = `import { Effect } from 'effect';
export function shouldUseInternalValidationModel() {
  return Effect.succeed(false);
}
export function validationModel() {
  throw new Error('The validation model is not available in this build.');
}
`;

/** @type {import('esbuild').Plugin} */
export const stubInternalValidationModel = {
  name: 'stub-internal-validation-model',
  setup(build) {
    build.onResolve({ filter: /validationModel$/ }, async (args) => {
      if (args.pluginData === realModule) return undefined;
      const resolved = await build.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: realModule,
      });
      return resolved.path === realModule
        ? { path: 'stub', namespace: 'internal-validation-model' }
        : undefined;
    });
    build.onLoad(
      { filter: /.*/, namespace: 'internal-validation-model' },
      () => ({ contents: STUB, loader: 'js', resolveDir: dirname(realModule) }),
    );
  },
};
