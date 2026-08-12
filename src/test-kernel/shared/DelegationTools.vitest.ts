import { expect, expectTypeOf, it } from 'vitest';

import {
  DELEGATION_TOOLS,
  type CanonicalDelegationToolName,
} from '@shared/constants/delegationTools';
import type { RegisteredToolName } from '@tools/registry';

it('keeps canonical delegation tool names registered', () => {
  expectTypeOf<CanonicalDelegationToolName>().toExtend<RegisteredToolName>();
});

it('contains the canonical delegation tool names', () => {
  expect([...DELEGATION_TOOLS]).toEqual([
    'delegate_workflow',
    'delegate_multi_agents',
    'delegate_agent',
  ]);
});
