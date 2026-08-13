// Third-party imports
import { expectTypeOf, it } from 'vitest';

// Local imports - progress view events
import {
  ProgressEvents,
  type PermissionActionDetail,
  type PermissionDecision,
} from '@progressView/frontend/events';

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type DetailFor<K extends PermissionActionDetail['kind']> = Extract<
  PermissionActionDetail,
  { kind: K }
>;

it('makes contradictory permission decisions unrepresentable', () => {
  expectTypeOf<
    IsAssignable<{ action: 'approve' }, PermissionDecision<'externalInquiry'>>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<{ action: 'submit' }, PermissionDecision<'userQuestion'>>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { action: 'reject'; model: string },
      PermissionDecision<'proposal'>
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { action: 'setup'; agent: string },
      PermissionDecision<'proposal'>
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { action: 'openDiff'; feedback: string },
      PermissionDecision<'toolEdit'>
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<{ action: 'openDiff' }, PermissionDecision<'bash'>>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { action: 'approve'; feedback: string },
      PermissionDecision<'planApproval'>
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      { action: 'cancel'; feedback: string },
      PermissionDecision<'retry'>
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsAssignable<
      {
        kind: 'proposal';
        data: DetailFor<'proposal'>['data'];
        decision: { action: 'openDiff' };
      },
      PermissionActionDetail
    >
  >().toEqualTypeOf<false>();
});

it('keeps the event factory permission and decision kinds correlated', () => {
  const invalidFactoryCall = (
    proposal: Omit<DetailFor<'proposal'>, 'decision'>,
  ): void => {
    // @ts-expect-error A proposal cannot emit a tool-edit decision.
    ProgressEvents.permissionAction(proposal, { action: 'openDiff' });
  };

  expectTypeOf(invalidFactoryCall).toBeFunction();
});
