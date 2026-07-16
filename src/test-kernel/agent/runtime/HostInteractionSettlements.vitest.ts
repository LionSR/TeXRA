// Third-party imports
import { expect, expectTypeOf, it } from 'vitest';

// Local imports - host interactions
import {
  cancellationResultFor,
  type HostBashApprovalResult,
  type HostUserQuestionResult,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type RetrySettlement,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';

type IsAssignable<From, To> = [From] extends [To] ? true : false;

it('makes contradictory interaction decisions unrepresentable', () => {
  expectTypeOf<
    IsAssignable<{ action: 'submit' }, UserQuestionSettlement>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { action: 'reject'; answers: { choice: string } },
      UserQuestionSettlement
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<{ submitted: true }, HostUserQuestionResult>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { submitted: false; answers: { choice: string } },
      HostUserQuestionResult
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<{ action: 'approve'; feedback: string }, PlanApprovalResult>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<{ action: 'reject'; model: string }, ProposalResult>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<{ action: 'cancel'; feedback: string }, RetrySettlement>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<{ action: 'cancel'; reason: string }, RetrySettlement>
  >().toEqualTypeOf<false>();
});

it("returns each interaction kind's exact cancellation result", () => {
  expectTypeOf(
    cancellationResultFor('bash'),
  ).toEqualTypeOf<HostBashApprovalResult>();
  expectTypeOf(
    cancellationResultFor('plan'),
  ).toEqualTypeOf<PlanApprovalResult>();
  expectTypeOf(
    cancellationResultFor('proposal'),
  ).toEqualTypeOf<ProposalResult>();
  expectTypeOf(cancellationResultFor('retry')).toEqualTypeOf<RetryResult>();
  expectTypeOf(
    cancellationResultFor('userQuestion'),
  ).toEqualTypeOf<HostUserQuestionResult>();
});

it('normalizes bash cancellation feedback like an explicit rejection', () => {
  expect(cancellationResultFor('bash', '  reason  ')).toEqual({
    accepted: false,
    timedOut: undefined,
    userMessage: 'reason',
  });
});
