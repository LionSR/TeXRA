import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import { parseApprovalDecision } from './approvalRequest.ts';

Deno.test('parseApprovalDecision accepts explicit boolean values', () => {
  strictEqual(
    parseApprovalDecision({ user_code: 'BCDF2345', approve: true }),
    true,
  );
  strictEqual(
    parseApprovalDecision({ user_code: 'BCDF2345', approve: false }),
    false,
  );
});

Deno.test('parseApprovalDecision rejects non-boolean values', () => {
  const malformedBodies = [
    { user_code: 'BCDF2345' },
    { user_code: 'BCDF2345', approve: null },
    { user_code: 'BCDF2345', approve: 'true' },
    { user_code: 'BCDF2345', approve: 1 },
    { user_code: 'BCDF2345', approve: { value: true } },
  ];

  deepStrictEqual(
    malformedBodies.map(parseApprovalDecision),
    malformedBodies.map(() => null),
  );
});
