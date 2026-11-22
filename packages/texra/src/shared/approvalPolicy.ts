import type { ApprovalPolicy } from '@texra-ai/worldline/schemas';

/** The policy TeXRA uses when the user has not chosen one for their project. */
export const TEXRA_APPROVAL_DEFAULT = 'yolo' satisfies ApprovalPolicy;
