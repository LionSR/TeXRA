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
const VOCABULARY_OWNER = 'packages/harness/src/shared/approvalPolicy.ts';

/**
 * Sites allowed to call `decideTexraApproval` / `decideRetryApproval` /
 * `decideHumanInputRequest` / `decideProposalApproval`. Core is the one
 * authority: `requestPolicy.ts` decides what the policy settles when a request
 * opens, the command and edit tools decide what only they know. A host must not grow a second evaluator — extend
 * this allowlist in the same PR if a new core surface is intentional.
 */
const EVALUATOR_CALL_ALLOWLIST = new Set([
  'packages/harness/src/shared/approvalPolicy.ts',
  'packages/harness/src/agent/runtime/requestPolicy.ts',
  'packages/harness/src/tools/approval/bashApproval.ts',
  'packages/harness/src/tools/approval/toolEditApproval.ts',
  'packages/harness/src/tools/delegation/proposalFlow.ts',
]);

/**
 * Sites allowed to override a session's approval policy. The persisted
 * `texra.approvalPolicy` setting owns a project's policy and every session
 * reads it live; only a CLI invocation overrides it for its own in-process
 * session (`--approval-policy`, a local chat's `/approval`). A host window
 * or the service never joins: a window writes the setting, and the service
 * follows it for every client of the project.
 */
const OVERRIDE_CALL_ALLOWLIST = new Set([
  'packages/cli/src/runtime/executeCli.ts',
  'packages/cli/src/runtime/approvalAdapter.ts',
  'packages/cli/src/chat/tui/runChatTui.tsx',
]);

/**
 * Sites allowed to write a run's bypass or goal grant. A host reaches them
 * only by sending `policy.set`; a launch, a delegation and a goal are the
 * core paths that grant on a run's behalf. Extend in the same PR when a new
 * core path is intentional; a host site never joins.
 */
const BYPASS_WRITE_ALLOWLIST = new Set([
  'packages/harness/src/agent/runtime/runApprovalQueue.ts',
  'packages/harness/src/agent/runtime/loop/step.ts',
  // An Auto-approve launch's grants, on its `run.start`.
  'packages/harness/src/agent/runtime/runAgent.ts',
  // `policy.set`, the one host door, committed as its row.
  'packages/harness/src/controllers/session/pendingUnderBypass.ts',
  'packages/harness/src/tools/approval/index.ts',
  'packages/harness/src/tools/delegation/AgentTool.ts',
  // A goal's grant, committed with its goal row.
  'packages/harness/src/tools/goal/goalRows.ts',
]);

const EVALUATOR_CALL =
  /\b(?:decideTexraApproval|decideRetryApproval|decideHumanInputRequest|decideProposalApproval)\s*\(/;
const BYPASS_WRITE_CALL =
  /\b(?:humanGrant|goalGrant|delegatedChildGrants)\s*\(|\.approvals\.change\s*\(/;
const POLICY_OVERRIDE_CALL = /\.approvals\.override\s*\(/;
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

  it('restricts policy overrides to the CLI invocations that own their session', () => {
    expectNoOffenders(
      offendersMatching(POLICY_OVERRIDE_CALL, OVERRIDE_CALL_ALLOWLIST),
      'override a session approval policy; a window or the service writes the persisted setting instead',
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
