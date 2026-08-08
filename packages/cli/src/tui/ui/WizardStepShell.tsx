// Third-party imports
import { Box, Text } from 'ink';

// Local imports - TUI presentation
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';

interface WizardStepShellProps {
  readonly children: React.ReactNode;
  readonly title: React.ReactNode;
  readonly subtitle: string;
  readonly keyHints: readonly KeyHint[];
  readonly statusLines?: readonly string[];
  readonly footerHints?: readonly string[];
}

/** Shared step scaffold for Ink wizards: a title/subtitle header, optional
 *  status and footer lines around the step's own content, and a key-hints
 *  footer. Used by both `texra init` and the orchestration launcher so a new
 *  step only declares what it shows, not how it's framed. */
export function WizardStepShell({
  children,
  footerHints = [],
  keyHints,
  statusLines = [],
  subtitle,
  title,
}: WizardStepShellProps): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      {title}
      <Text dimColor>{subtitle}</Text>
      {statusLines.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {statusLines.map((line, index) => (
            <Text key={`${index}:${line}`} dimColor wrap="wrap">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      {footerHints.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {footerHints.map((hint) => (
            <Text key={hint} dimColor wrap="wrap">
              {hint}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints hints={keyHints} confirmCancel={false} />
      </Box>
    </Box>
  );
}
