---
created: 2026-09-20
status: implemented
---

# Agent-refactorability gates: what an autonomous refactor needs from the repo

Owner direction this serves: the repo should be safe for an AI agent to
improve on its own. An agent wastes effort, or misleads itself, when it
cannot find a module's tests, re-proposes a refactor that was already
refused, trusts a doc that no longer describes the code, or grows a file or
a seam nobody measures. The 2026-09-20 survey named those gaps; each now has
a gate, listed here by what it answers.

## 1. Test estate

- **Tiers are computed, not declared.** `vitest.config.mjs` puts a suite in
  `pure` or `kernel` from what its source reaches; there is no list of
  exempt suites, and a module that reads an ambient host is a production
  defect, not a test-config exception (`src/test-kernel/AGENTS.md`, "Test
  tiers"). The fake platform (`src/test-kernel/support/setupPlatform.ts`,
  `FakePlatform.ts`) remains the kernel tier's host.
- **Mocks of harness internals are measured.**
  `config/ratchets/core-quality/core-module-mocks.json`
  (`scripts/core-quality-measure.mjs`) counts `vi.mock` of `@agent/*`
  internals from CLI, desktop and shared support, and only shrinks. The
  older `host-agent-mock-baseline.json` is kept empty because a budget file
  may not be deleted.
- **A suite names its subject.** One suite per module, path-mirrored under
  `src/test-kernel/`, or one named cross-module scenario stated in the PR
  body (`src/test-kernel/AGENTS.md`).

## 2. Rulings and refusals as data

The architecture rulings ledger is prose, and an agent kept re-proposing
`withPerKeyLane` onto `Semaphore` and `ModelRetryGate` onto `Schedule`.
`config/ratchets/refuted-candidates.json` records each investigated, costed
and refused candidate: an `id`, the `symbols` that carry its shape, and a
`ruling` anchor. `src/test-kernel/architecture/refutedCandidatesRatchet.vitest.ts`
pins every symbol's signature, so a symbol that changes shape fails until
the baseline is updated in the same PR. Citing the candidate's `id` in the
PR body is a convention; a PR-body check
(`.github/workflows/refuted-candidates.yml`) once enforced it and was
removed as low value. <!-- guidance-refs-ignore -->

The ratchet does not forbid the change. A PR that lands a candidate on new
evidence cites the id, says what changed, and deletes or rewrites the entry.

## 3. Docs whose status is typed, not derived

- **One index of owners.** `.agents/docs/INDEX.md` names the authoritative
  note per topic and links the rulings ledger; `.agents/docs/README.md`
  forbids any second index.
- **A settled note cannot stay in `proposed/`.**
  `scripts/check-proposal-status.mjs` fails a `proposed/` note whose status
  line names a settled lifecycle, or that has a `Landed` section and no
  section saying what is still open. Citing a merged PR is not a completion
  marker.
- **Guidance cannot cite what does not exist.**
  `scripts/check-guidance-refs.mjs` checks that the repo paths and local
  links cited in CLAUDE.md, AGENTS.md, `.claude/skills/` and `docs/dev/`
  resolve, and that every backticked event-type literal names a real arm of
  the run vocabulary.

## 4. Size and error-channel ratchets

- `config/ratchets/core-quality/` holds shrink-only per-rule baselines,
  `file-size.json` among them (`npm run check:core-quality`, in
  `gate:invariants`). A file over its budget fails, and a shorter file
  passes.
- `scripts/check-ratchet-baselines.mjs` runs first in `gate:invariants` and
  fails a raised count, a new allowance or a deleted baseline compared with
  the PR base.
- `src/test-kernel/architecture/unknownErrorChannelRatchet.vitest.ts`
  forbids an Effect error channel spelled `unknown`.

## 5. Apparatus

- Every desktop artifact check and Electron smoke run is one entry point,
  `node scripts/verify-desktop.mjs <stage>`.
- The versions `packages/harness` redeclares come from the pnpm `catalog:`
  in `pnpm-workspace.yaml`, one source for both manifests.
- Single-site dependencies that a few lines replace were removed.
  `content-disposition` (RFC 6266/5987 filename decoding),
  `diff-match-patch` (fuzzy `patch_apply` onto a file the user changed) and
  `ipaddr.js` (the SSRF range classification in the web fetch tool) stay
  for the reasons given, and `pretty-bytes` stays by owner ruling
  (2026-10-06).
