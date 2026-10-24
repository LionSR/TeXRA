import { Schema, SchemaGetter } from 'effect';

const SKILL_NAME_MAX_LENGTH = 64;

/** Canonical grammar for discovered and persisted skill names. */
export const SkillNameSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Unknown /* TODO(effect-schema): transform target schema; was `.transform((name) => name.replaceAll(/\s+/g, ' ').trim())` */,
    {
      decode: SchemaGetter.transform((name) =>
        name.replaceAll(/\s+/g, ' ').trim(),
      ),
      encode: SchemaGetter.forbidden(() => 'decode-only'),
    },
  ),
)
  .check(
    Schema.makeFilter((name) => name.length > 0, {
      message: 'Skill name is required',
    }),
  )
  .check(
    Schema.makeFilter(
      (name) => name.length <= SKILL_NAME_MAX_LENGTH,
      `Skill name must be at most ${SKILL_NAME_MAX_LENGTH} characters`,
    ),
  )
  .check(
    Schema.makeFilter((name) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name), {
      message:
        'Skill name must contain only lowercase letters, digits, and hyphens',
    }),
  )
  .check(
    Schema.makeFilter((name) => !name.includes('--'), {
      message: 'Skill name must not contain repeated hyphens',
    }),
  );

/**
 * A skill's name as the catalog, the switches and the transcript carry it:
 * a bare name, or `<plugin>:<name>` for a skill or command an installed
 * plugin contributes. A skill's own frontmatter takes the bare grammar only,
 * so no skill names itself into a plugin's namespace.
 */
export const QualifiedSkillNameSchema = Schema.String.check(
  Schema.makeFilter(
    (name) => {
      const parts = name.split(':');
      return (
        parts.length <= 2 &&
        parts.every(
          (part) =>
            Schema.decodeUnknownResult(SkillNameSchema)(part).data === part,
        )
      );
    },
    { message: 'Skill name must be a skill name, or <plugin>:<skill name>' },
  ),
);
