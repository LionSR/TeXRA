// Third-party imports
import { Box, Text } from 'ink';

// Local imports - TUI presentation
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';

interface WizardStepShellProps {
  readonly children: React.ReactNode;
  readonly title: React.ReactNode;
  readonly subtitle: string;
  readonly keyHints: readonly KeyHint[];
}

/** Shared step scaffold for Ink wizards: a title/subtitle header above the
 *  step's own content, and a key-hints footer. Used by `texra init` so a new
 *  step only declares what it shows, not how it's framed. */
export function WizardStepShell({
  children,
  keyHints,
  subtitle,
  title,
}: WizardStepShellProps): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      {title}
      <Text dimColor>{subtitle}</Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={keyHints} confirmCancel={false} />
      </Box>
    </Box>
  );
}
