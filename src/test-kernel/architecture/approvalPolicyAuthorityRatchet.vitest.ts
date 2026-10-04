// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  ALL_HOST_PRODUCTION_ROOTS,
  expectRealCoverage,
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

/** Only the shared module may define the three-value TeXRA policy vocabulary. */
const VOCABULARY_OWNER = 'src/shared/approvalPolicy.ts';

/**
 * Sites allowed to call `decideTexraApproval` / `decideRetryApproval` /
 * `decideHumanInputRequest` / `decideProposalApproval`. Core is the one
 * authority: `requestPolicy.ts` decides what the policy settles when a request
 * opens, the command and edit tools decide what only they know. A host must not grow a second evaluator — extend
 * this allowlist in the same PR if a new core surface is intentional.
 */
const EVALUATOR_CALL_ALLOWLIST = new Set([
  'src/shared/approvalPolicy.ts',
  'src/agent/runtime/requestPolicy.ts',
  'src/tools/approval/bashApproval.ts',
  'src/tools/approval/toolEditApproval.ts',
  'src/tools/delegation/proposalFlow.ts',
]);

/**
 * Sites allowed to call `setApprovalPolicy`. Seed/update only — extend in the
 * same PR when a new composition root is intentional.
 */
const SEED_CALL_ALLOWLIST = new Set([
  'src/agent/runtime/SessionHandle.ts',
  'packages/cli/src/runtime/executeCli.ts',
  'src/controllers/settingsView/sharedSettingsCommands.ts',
  'packages/cli/src/runtime/approvalAdapter.ts',
  'packages/cli/src/chat/tui/runChatTui.tsx',
  'packages/cli/src/chat/tui/commands/handlers/approvalCommand.ts',
  'packages/cli/scripts/tui-harness.tsx',
  'packages/extension/src/extension.ts',
  'packages/desktop/src/main/desktopProjects.ts',
  // The service seeds each project it opens from that project's settings,
  // and `project.policy` is a window's settings change reaching it.
  'packages/cli/src/runtime/cliService.ts',
  'src/controllers/server/handlers.ts',
]);

/**
 * Sites allowed to write a run's bypass or goal grant. A host reaches them
 * only by sending `policy.set`; a launch, a delegation and a goal are the
 * core paths that grant on a run's behalf. Extend in the same PR when a new
 * core path is intentional; a host site never joins.
 */
const BYPASS_WRITE_ALLOWLIST = new Set([
  'src/agent/runtime/runApprovalQueue.ts',
  'src/agent/runtime/loop/step.ts',
  'src/controllers/mainView/backend/MainViewRunLaunchController.ts',
  'src/controllers/session/SessionRequests.ts',
  'src/tools/approval/index.ts',
  'src/tools/goal/goalAutoApproval.ts',
]);

const EVALUATOR_CALL =
  /\b(?:decideTexraApproval|decideRetryApproval|decideHumanInputRequest|decideProposalApproval)\s*\(/;
const BYPASS_WRITE_CALL =
  /\b(?:setBypass|setDelegatedWorkBypasses|setGoalGrant)\s*\(/;
const SET_APPROVAL_POLICY_CALL = /\bsetApprovalPolicy\s*\(/;
const POLICY_VOCABULARY_DEFINITION =
  /\b(?:const|type)\s+(?:TEXRA_APPROVAL_POLICIES|TexraApprovalPolicySchema)\b/;

function readProductionSource(file: string): string {
  return stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
}

function offendersMatching(
  pattern: RegExp,
  allowlist: ReadonlySet<string>,
): string[] {
  return ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder)
    .filter((file) => !allowlist.has(file))
    .filter((file) => pattern.test(readProductionSource(file)))
    .toSorted();
}

function expectNoOffenders(offenders: string[], guidance: string): void {
  expect(
    offenders,
    offenders.length === 0 ? undefined : `${offenders.join(', ')} ${guidance}`,
  ).toEqual([]);
}

describe('approval policy authority ratchet', () => {
  it('keeps the three-value TeXRA policy vocabulary in one shared module', () => {
    expectNoOffenders(
      offendersMatching(
        POLICY_VOCABULARY_DEFINITION,
        new Set([VOCABULARY_OWNER]),
      ),
      `redefine TeXRA approval-policy vocabulary; if intentional, move the definition into ${VOCABULARY_OWNER} or extend this allowlist in the same PR`,
    );
  });

  it('restricts evaluator call sites to the shared boundaries and core doors', () => {
    expectNoOffenders(
      offendersMatching(EVALUATOR_CALL, EVALUATOR_CALL_ALLOWLIST),
      'call the shared TeXRA approval evaluator; if intentional, extend EVALUATOR_CALL_ALLOWLIST in this PR',
    );
  });

  it('restricts setApprovalPolicy call sites to composition and settings seeds', () => {
    expectNoOffenders(
      offendersMatching(SET_APPROVAL_POLICY_CALL, SEED_CALL_ALLOWLIST),
      'call setApprovalPolicy; if intentional, extend SEED_CALL_ALLOWLIST in this PR',
    );
  });

  it('restricts bypass and goal-grant writes to the core paths that grant', () => {
    expectNoOffenders(
      offendersMatching(BYPASS_WRITE_CALL, BYPASS_WRITE_ALLOWLIST),
      'write a run bypass or goal grant; if intentional, extend BYPASS_WRITE_ALLOWLIST in this PR',
    );
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
