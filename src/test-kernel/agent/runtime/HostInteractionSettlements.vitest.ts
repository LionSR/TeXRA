// Third-party imports
import { expectTypeOf, it } from 'vitest';

// Local imports - host interactions
import type {
  HostInteractionSettlement,
  HostUserQuestionResult,
  PlanApprovalResult,
  ProposalResult,
  RetrySettlement,
  UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';

type IsAssignable<From, To> = [From] extends [To] ? true : false;

it('makes contradictory interaction settlements unrepresentable', () => {
  expectTypeOf<
    IsAssignable<
      { kind: 'retry'; decision: { action: 'approve' } },
      HostInteractionSettlement
    >
  >().toEqualTypeOf<false>();
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
    IsAssignable<
      {
        kind: 'proposal';
        decision: { action: 'approve' };
        value: { action: 'approve' };
      },
      HostInteractionSettlement
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { kind: 'externalInquiry'; action: 'submit' },
      HostInteractionSettlement
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
