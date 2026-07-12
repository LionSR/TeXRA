/** Parse an explicit approval decision from an untrusted request body. */
export function parseApprovalDecision(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }

  const approve = (body as Record<string, unknown>).approve;
  return typeof approve === 'boolean' ? approve : null;
}
