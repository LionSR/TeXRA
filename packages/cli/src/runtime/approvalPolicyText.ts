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

// Only the three documented names are accepted. Earlier builds also took
// `default`/`interactive`/`on`/`off`/`deny`/`auto`/`full`/`danger`, but those
// undocumented synonyms only bloated the accepted-value list, and `on`/`off`
// were ambiguous about which policy they meant.
export function parseCliApprovalPolicy(
  input: string,
): CliApprovalPolicy | undefined {
  const normalized = input.trim().toLowerCase();
  return (CLI_APPROVAL_POLICIES as readonly string[]).includes(normalized)
    ? (normalized as CliApprovalPolicy)
    : undefined;
}
