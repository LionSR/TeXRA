import { expect, expectTypeOf, it } from 'vitest';

import {
  DELEGATION_TOOLS,
  type CanonicalDelegationToolName,
} from '@shared/constants/delegationTools';
import type { RegisteredToolName } from '@tools/registry';

it('keeps canonical delegation tool names registered', () => {
  expectTypeOf<CanonicalDelegationToolName>().toMatchTypeOf<RegisteredToolName>();
});

it('preserves canonical and historical delegation tool names', () => {
  expect([...DELEGATION_TOOLS]).toEqual([
    'delegate_workflow',
    'delegate_workflow_script',
    'delegate_agent',
    'resume_agent',
    'propose_workflow',
    'propose_agent',
  ]);
});
