import { Box, Text } from 'ink';

import type { ActiveSkillSummary } from '@shared/schemas';

const MAX_SKILL_ROWS = 3;
const NARROW_SKILLS_COLUMNS = 48;

export function activeSkillsPanelRowCount(
  skills: readonly ActiveSkillSummary[],
  columns: number,
): number {
  if (skills.length === 0 || columns <= 0) return 0;
  if (columns < NARROW_SKILLS_COLUMNS) return 1;
  return Math.min(MAX_SKILL_ROWS, skills.length + 1);
}

interface ActiveSkillsPanelProps {
  readonly columns: number;
  readonly maxRows: number;
  readonly skills: readonly ActiveSkillSummary[];
}

/** Compact bounded catalog for the focused stream. */
export function ActiveSkillsPanel({
  columns,
  maxRows,
  skills,
}: ActiveSkillsPanelProps): React.JSX.Element | null {
  if (skills.length === 0 || maxRows <= 0 || columns <= 0) return null;

  if (maxRows === 1 || columns < NARROW_SKILLS_COLUMNS) {
    return (
      <Box width={columns} height={1} overflowY="hidden">
        <Text bold wrap="truncate-end">
          {`Skills (${skills.length}): ${skills.map((skill) => skill.name).join(', ')}`}
        </Text>
      </Box>
    );
  }

  const visible = skills.slice(0, maxRows - 1);
  const remaining = skills.length - visible.length;
  return (
    <Box
      flexDirection="column"
      width={columns}
      maxHeight={maxRows}
      overflowY="hidden"
    >
      <Text bold>{`Skills (${skills.length})`}</Text>
      {visible.map((skill, index) => {
        const suffix =
          index === visible.length - 1 && remaining > 0
            ? ` (+${remaining} more)`
            : '';
        return (
          <Text key={`${skill.name}:${skill.source}`} wrap="truncate-end">
            {`  ${skill.name} [${skill.source}] ${skill.description}${suffix}`}
          </Text>
        );
      })}
    </Box>
  );
}
