// Third-party imports
import { expect, expectTypeOf, it } from 'vitest';

// Local imports - host interactions
import {
  type BashSettlement,
  cancellationResultFor,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type RetrySettlement,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';

it('makes contradictory interaction decisions unrepresentable', () => {
  expectTypeOf<{ action: 'submit' }>().not.toExtend<UserQuestionSettlement>();
  expectTypeOf<{
    action: 'reject';
    answers: { choice: string };
  }>().not.toExtend<UserQuestionSettlement>();
  expectTypeOf<{
    action: 'approve';
    feedback: string;
  }>().not.toExtend<PlanApprovalResult>();
  expectTypeOf<{
    action: 'reject';
    model: string;
  }>().not.toExtend<ProposalResult>();
  expectTypeOf<{
    action: 'cancel';
    feedback: string;
  }>().not.toExtend<RetrySettlement>();
  expectTypeOf<{
    action: 'cancel';
    reason: string;
  }>().not.toExtend<RetrySettlement>();
  expectTypeOf<{ action: 'timeout' }>().not.toExtend<PlanApprovalResult>();
  expectTypeOf<{ action: 'timeout' }>().not.toExtend<ProposalResult>();
  expectTypeOf<{ action: 'timeout' }>().not.toExtend<RetrySettlement>();
  expectTypeOf<{ action: 'timeout' }>().not.toExtend<BashSettlement>();
});

it("returns each interaction kind's exact cancellation result", () => {
  expectTypeOf(cancellationResultFor('bash')).toEqualTypeOf<BashSettlement>();
  expectTypeOf(
    cancellationResultFor('planApproval'),
  ).toEqualTypeOf<PlanApprovalResult>();
  expectTypeOf(
    cancellationResultFor('proposal'),
  ).toEqualTypeOf<ProposalResult>();
  expectTypeOf(cancellationResultFor('retry')).toEqualTypeOf<RetryResult>();
  expectTypeOf(
    cancellationResultFor('userQuestion'),
  ).toEqualTypeOf<UserQuestionSettlement>();
});

it('keeps bash cancellation causes distinct from user feedback', () => {
  expect(cancellationResultFor('bash', '  reason  ')).toEqual({
    action: 'reject',
    cause: 'reason',
  });
});
