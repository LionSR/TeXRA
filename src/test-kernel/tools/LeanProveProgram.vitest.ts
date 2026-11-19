// The `prove` program's own check, run as its run runs it: the program's
// modules in the script sandbox, over the real `lean_diagnostics` and a Lean
// that elaborates whatever the file holds without complaint.
//
// The failure mode this suite guards, reproduced before the fix: a round
// "finishes" a proof by declaring an axiom. Lean then reports no error and
// no `sorry`, and the check called the file clean.

import * as NodeWorker from '@effect/platform-node/NodeWorker';
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect } from 'vitest';

import { CodeSandbox } from '@agent/codeSandbox/codeSandbox';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { SessionGraph } from '@test/support/testKernel';
import { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import { LeanDiagnosticsTool } from '@texra/tools/lean/LspTools';
import { LEAN_MODULES } from '@texra/tools/lean/programs';

const STATED = `/-- Kept from before the run. -/
axiom given : True

-- An axiom in a comment declares nothing.
theorem two : 1 + 1 = 2 := by
  sorry
`;

const CHEATED = `/-- Kept from before the run. -/
axiom given : True

private axiom cheat : 1 + 1 = 2

-- An axiom in a comment declares nothing.
theorem two : 1 + 1 = 2 := cheat
`;

layer(
  Layer.merge(
    SessionGraph.hosted,
    CodeSandbox.layer.pipe(Layer.provide(NodeWorker.layerPlatform)),
  ),
  { excludeTestServices: true },
)('the prove program', (it) => {
  it.effect('a round that adds an axiom leaves the file unproved', () =>
    Effect.gen(function* () {
      let source = STATED;
      let rounds = 0;
      // Lean reports nothing on either text: the first is asked before its
      // `sorry` matters, and the axiom makes the second elaborate.
      const lean = Layer.succeed(
        LeanLanguageServices,
        // cast: the check reads a file's diagnostics and nothing else.
        {
          fetchDiagnosticsForFile: () =>
            Effect.succeed({ complete: true, diagnostics: [], text: source }),
        } as unknown as LeanLanguageServices['Service'],
      );
      const diagnostics = (input: unknown) =>
        LeanDiagnosticsTool.call(input).pipe(
          Effect.provide(Layer.merge(nativeToolTestLayer(), lean)),
          // A failed call has no value; the script then reads `undefined`.
          Effect.map((result) =>
            result.status === 'executed' ? result.value : undefined,
          ),
        );
      const result = yield* (yield* CodeSandbox).run({
        source: `const { default: prove } = await import('builtIn:prove');
return await prove({}, { instruction: '', inputFiles: ['Basic.lean'], contextFiles: [], mediaFiles: [] });`,
        tools: ['lean_file', 'lean_diagnostics'],
        globals: ['agent'],
        modules: Object.fromEntries(
          Object.entries(LEAN_MODULES).map(([name, module]) => [
            `builtIn:${name}`,
            module,
          ]),
        ),
        timeout: '20 seconds',
        call: (op) =>
          Effect.gen(function* () {
            if (op.name === 'lean_diagnostics')
              return { _tag: 'Value', value: yield* diagnostics(op.input) };
            if (op.name === 'agent()') {
              rounds += 1;
              source = CHEATED;
              return { _tag: 'Value', value: { response: 'Proved.' } };
            }
            return { _tag: 'Value', value: {} };
          }),
      });

      expect(rounds).toBe(3);
      expect(result.value).toContain('After 3 rounds the check still reports');
      expect(result.value).toContain('cheat');
      expect(result.value).not.toContain('given');
    }),
  );
});
