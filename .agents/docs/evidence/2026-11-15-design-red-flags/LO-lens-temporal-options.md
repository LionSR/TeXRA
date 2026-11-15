# LO lens: temporal decomposition, conjoined methods, special and general mixed, options for a special case

Read on `main` at `cb22acd`; covered `packages/*/src` (cli, desktop, extension, harness, llm, texra, trace-viewer), production code only, with tests grepped separately for consumer counts.

### LO-1: The CLI's `--input`/`--context` expansion is still a prepare/finish pair over a carried record, with a guard every caller turns on

- **Package:** cli
- **Flags:** temporal decomposition, conjoined methods, an option for a special case
- **Evidence:** Remainder of TC7 (`../2026-11-07-design-red-flags-lenses/temporal-conjoined.md` Finding 7, second item) and of round 5 tests finding 3 (`../2026-11-07-design-red-flags-round-5-tests/2-code-for-tests.md:254-281`). The catalogue row for TC7 says the expansion was "already gone"; it was renamed, not removed. `packages/cli/src/runtime/headless/documentTaskInputs.ts:216-248` (`prepareDocumentTaskInputExpansion`) and `:250-281` (`finishDocumentTaskInputExpansion`) are joined by `PreparedDocumentTaskInputExpansion` (`:72-75`), which carries `flagLabel` from one to the other; the one caller runs prepare, prepare, finish, finish in that order (`:349-373`). `requireWorkspaceFiles?` (`:67`, read at `:49`) is `true` at both production callers (`packages/cli/src/commands/run.ts:290`, `packages/cli/src/commands/team.ts:181`); the only other caller is `packages/cli/test/cli/DocumentTaskInputsLifecycle.vitest.ts:71`, which passes stdin only, so the unguarded path is never exercised with a path.
- **Better design:** `expandRunInputs` expands both flags' specs in one `Effect.forEach` (each entry tagged with its flag label), reads stdin once when a spec is `-`, then assembles. The outside-`--cwd` check always runs.
- **Deleted:** `prepareDocumentTaskInputExpansion`, `finishDocumentTaskInputExpansion`, `PreparedDocumentTaskInputExpansion`, `requireWorkspaceFiles` (field, the `shared` object at `:347`, the `=== true` test at `:49`, two call-site lines).
- **Size:** about 70 lines, 3 files.
- **Risk / owner decision:** none.

