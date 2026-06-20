import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../schemas/cliSettings';

export function formatCliApprovalPolicy(policy: CliApprovalPolicy): string {
  switch (policy) {
    case 'ask':
      return 'ask before privileged actions';
    case 'never':
      return 'deny privileged actions';
    case 'yolo':
      return 'auto-approve privileged actions';
  }
}

export function parseCliApprovalPolicy(
  input: string,
): CliApprovalPolicy | undefined {
  const normalized = input.trim().toLowerCase();
  if ((CLI_APPROVAL_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as CliApprovalPolicy;
  }
  switch (normalized) {
    case 'default':
    case 'interactive':
    case 'on':
      return 'ask';
    case 'off':
    case 'deny':
      return 'never';
    case 'auto':
    case 'full':
    case 'danger':
      return 'yolo';
    default:
      return undefined;
  }
}
