// esbuild plugin that keeps the package-validation model
// (`packages/cli/src/runtime/validationModel.ts`) out of a shipped CLI
// bundle. Every import that resolves to that file loads a stand-in instead,
// which serves no validation model, so the bundle carries neither the canned
// output nor a gate the environment can open.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const realModule = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/cli/src/runtime/validationModel.ts',
);

const STUB = `import { Layer } from 'effect';
export const validationModelLayer = Layer.empty;
`;

/** @type {import('esbuild').Plugin} */
export const stubInternalValidationModel = {
  name: 'stub-internal-validation-model',
  setup(build) {
    build.onResolve({ filter: /validationModel(?:\.js)?$/ }, async (args) => {
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
    // An import the redirect missed fails the build instead of shipping the
    // real module.
    build.onLoad({ filter: /[\\/]validationModel\.ts$/ }, (args) => {
      throw new Error(
        `${args.path} reached the bundle past the validation-model stub.`,
      );
    });
  },
};
