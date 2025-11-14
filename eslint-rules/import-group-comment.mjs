export default {
  rules: {
    'import-group-comment': {
      meta: {
        type: 'suggestion',
        docs: {
          description:
            'Require a descriptive comment immediately above each import group.',
        },
        schema: [],
        messages: {
          missingComment:
            'Add a descriptive comment immediately above this import group.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        return {
          Program(program) {
            const imports = program.body.filter(
              (node) => node.type === 'ImportDeclaration',
            );
            for (let index = 0; index < imports.length; index += 1) {
              const node = imports[index];
              const previous = imports[index - 1];
              const isFirstImport = !previous;
              let hasBlankLine = false;
              if (!isFirstImport) {
                const betweenText = sourceCode.text.slice(
                  previous.range[1],
                  node.range[0],
                );
                hasBlankLine = /\n\s*\n/.test(betweenText);
              }
              if (!isFirstImport && !hasBlankLine) {
                continue;
              }
              const comments = sourceCode.getCommentsBefore(node);
              const lastComment = comments.at(-1);
              if (
                !lastComment ||
                lastComment.loc.end.line !== node.loc.start.line - 1
              ) {
                context.report({ node, messageId: 'missingComment' });
              }
            }
          },
        };
      },
    },
  },
};
