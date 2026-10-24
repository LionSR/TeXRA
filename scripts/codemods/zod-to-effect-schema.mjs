#!/usr/bin/env node
// Rewrites Zod schema code to Effect Schema (effect 4.x `Schema`).
//
//   node scripts/codemods/zod-to-effect-schema.mjs <file-or-dir> [...]
//
// Mechanical shapes are converted outright (objects, primitives, literals,
// enums, arrays, records, unions, optional/nullable/nullish, describe,
// brand, min/max checks, extend/pick/omit/merge, parse/safeParse, the
// `z.infer`/`z.input`/`z.output` type forms, `z.ZodType` in signatures).
// Everything else is converted to the nearest Effect form and marked with a
// `TODO(effect-schema)` comment that keeps the Zod text, so the hand pass
// and the type checker find every site. The `zod` import is removed and the
// Effect names the new text uses are added to the file's `effect` import.
//
// The script edits files in place and prints one line per file: the number
// of conversions and the number of markers left for the hand pass.

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import ts from 'typescript';

const TODO = 'TODO(effect-schema)';

/** Zod methods that may start a chain on a plain identifier (not `z`). */
const IDENT_CHAIN_METHODS = new Set([
  'optional',
  'nullable',
  'nullish',
  'describe',
  'extend',
  'pick',
  'omit',
  'merge',
  'partial',
  'required',
  'safeParse',
  'safeParseAsync',
  'parseAsync',
  'prefault',
  'brand',
  'readonly',
  'superRefine',
  'refine',
  'shape',
  'passthrough',
  'loose',
  'strict',
  'strip',
  'keyof',
  'catchall',
  'options',
  'element',
  'unwrap',
  'meta',
]);
/** Methods that continue a chain only when the receiver is already Zod. */
const CHAIN_ONLY_METHODS = new Set([
  'parse',
  'catch',
  'default',
  'transform',
  'pipe',
  'array',
  'min',
  'max',
  'length',
  'trim',
  'regex',
  'startsWith',
  'endsWith',
  'includes',
  'nonempty',
  'url',
  'email',
  'uuid',
  'gte',
  'lte',
  'gt',
  'lt',
  'positive',
  'nonnegative',
  'negative',
  'nonpositive',
  'int',
  'finite',
  'safe',
  'multipleOf',
  'toLowerCase',
  'toUpperCase',
  'and',
  'or',
  'check',
  'overwrite',
  'register',
  'def',
  '_def',
  '_zod',
]);
/** Identifiers the `.parse(` heuristic accepts as schema receivers. */
const SCHEMA_RECEIVER = /(Schema|Codec)\b$|^schema$/;

const ZERO_ARG_BASES = {
  string: 'Schema.String',
  number: 'Schema.Number',
  boolean: 'Schema.Boolean',
  bigint: 'Schema.BigInt',
  symbol: 'Schema.Symbol',
  unknown: 'Schema.Unknown',
  any: 'Schema.Any',
  never: 'Schema.Never',
  null: 'Schema.Null',
  undefined: 'Schema.Undefined',
  void: 'Schema.Void',
  date: 'Schema.Date',
  int: 'Schema.Int',
  json: 'Schema.Json',
  uuid: 'Schema.String.check(Schema.isUUID())',
};
const BASE_KIND = {
  string: 'string',
  int: 'number',
  number: 'number',
  uuid: 'string',
};

class Converter {
  constructor(sf, text) {
    this.sf = sf;
    this.text = text;
    this.needs = new Set(['Schema']);
    this.conversions = 0;
    this.todos = 0;
    this.schemaNames = this.collectSchemaNames();
    this.safeParseVars = this.collectSafeParseVars();
  }

  src(node) {
    return this.text.slice(node.getStart(this.sf), node.getEnd());
  }

  todo(what, keep, replacement) {
    this.todos += 1;
    return `${replacement} /* ${TODO}: ${what}; was \`${keep.replace(/\*\//g, '* /').replace(/\s+/g, ' ')}\` */`;
  }

  /** Text of `node` converted: the node itself when it is a Zod root, else
   *  its text with every Zod root (and `safeParse` result read) inside it
   *  converted. */
  emit(node) {
    const root = this.rootOf(node);
    return root ? this.convertRoot(root) : this.within(node);
  }

  within(node) {
    const roots = [];
    const visit = (n) => {
      const root = this.rootOf(n);
      if (root) {
        roots.push([root, () => this.convertRoot(root)]);
        return;
      }
      const read = this.resultRead(n);
      if (read) {
        roots.push([n, () => read]);
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    let out = '';
    // From `pos`, not `getStart`: the leading trivia (a file's header comment,
    // a field's doc comment) belongs to the text being rebuilt.
    let cursor = node.pos;
    for (const [r, text] of roots.sort(
      (a, b) => a[0].getStart(this.sf) - b[0].getStart(this.sf),
    )) {
      out += this.text.slice(cursor, r.getStart(this.sf)) + text();
      cursor = r.getEnd();
    }
    return out + this.text.slice(cursor, node.getEnd());
  }

  /**
   * `parsed.success` / `.data` / `.error` on a variable a `safeParse` call
   * bound become the `Result` reads (`Result.isSuccess(parsed)`,
   * `parsed.success`, `parsed.failure`). Scoped to the block that declares
   * the variable.
   */
  resultRead(n) {
    if (!ts.isPropertyAccessExpression(n) || !ts.isIdentifier(n.expression))
      return null;
    const scopes = this.safeParseVars.get(n.expression.text);
    if (!scopes) return null;
    const at = n.getStart(this.sf);
    if (!scopes.some(([s, e]) => at >= s && at < e)) return null;
    this.needs.add('Result');
    switch (n.name.text) {
      case 'success':
        return `Result.isSuccess(${n.expression.text})`;
      case 'data':
        return `${n.expression.text}.success`;
      case 'error':
        return `${n.expression.text}.failure`;
      default:
        return null;
    }
  }

  collectSafeParseVars() {
    const vars = new Map();
    const visit = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        /\.safeParse\(/.test(this.src(n.initializer)) &&
        this.rootOf(n.initializer)
      ) {
        let scope = n.parent;
        while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope))
          scope = scope.parent;
        const list = vars.get(n.name.text) ?? [];
        list.push([scope.pos, scope.getEnd()]);
        vars.set(n.name.text, list);
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    return vars;
  }

  /** The node itself when it is a Zod root (expression chain or type). */
  rootOf(n) {
    if (ts.isTypeReferenceNode(n) && this.isZodQualified(n.typeName)) return n;
    if (
      ts.isExpressionWithTypeArguments(n) &&
      this.isZodQualifiedExpr(n.expression)
    )
      return n;
    if (!this.isChainLink(n)) return null;
    const p = n.parent;
    if (
      p &&
      ((ts.isPropertyAccessExpression(p) && p.expression === n) ||
        (ts.isCallExpression(p) && p.expression === n) ||
        (ts.isNonNullExpression(p) && p.expression === n)) &&
      this.isChainLink(p)
    )
      return null;
    return this.chainBottomIsZod(n) ? n : null;
  }

  isZodQualified(name) {
    return (
      ts.isQualifiedName(name) &&
      ts.isIdentifier(name.left) &&
      name.left.text === 'z'
    );
  }
  isZodQualifiedExpr(e) {
    return (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === 'z'
    );
  }

  isChainLink(n) {
    return (
      ts.isPropertyAccessExpression(n) ||
      ts.isCallExpression(n) ||
      ts.isNonNullExpression(n) ||
      (ts.isIdentifier(n) && n.text === 'z')
    );
  }

  /** Whether a chain's innermost receiver makes it a Zod chain. */
  chainBottomIsZod(n) {
    const links = [];
    let cur = n;
    while (true) {
      if (ts.isCallExpression(cur) || ts.isNonNullExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (ts.isPropertyAccessExpression(cur)) {
        links.push(cur.name.text);
        cur = cur.expression;
        continue;
      }
      break;
    }
    if (ts.isIdentifier(cur) && cur.text === 'z') {
      // `z` the import, not a local variable named z.
      return links.length > 0 && !this.isImportSpecifierName(cur);
    }
    // Identifier-rooted: the receiver must be named like a schema and the
    // first method must be one Zod has. (`Stream.unwrap`, `Option.map` and
    // every other Effect call are chains too; the name is what tells them
    // apart.)
    const first = links[links.length - 1];
    if (first === undefined) return false;
    if (!(ts.isIdentifier(cur) || ts.isPropertyAccessExpression(cur)))
      return false;
    // Only Zod spells these, whatever the receiver is called.
    if (
      first === 'safeParse' ||
      first === 'safeParseAsync' ||
      first === 'parseAsync'
    )
      return true;
    const receiver = this.src(cur);
    const named =
      SCHEMA_RECEIVER.test(receiver) ||
      (ts.isIdentifier(cur) && this.schemaNames.has(cur.text)) ||
      (ts.isPropertyAccessExpression(cur) &&
        this.schemaNames.has(cur.name.text));
    if (!named) return false;
    return IDENT_CHAIN_METHODS.has(first) || first === 'parse';
  }

  /** Names bound to a Zod chain in this file (`const X = z.object(...)`). */
  collectSchemaNames() {
    const names = new Set();
    const visit = (n) => {
      if (
        (ts.isVariableDeclaration(n) ||
          ts.isPropertyAssignment(n) ||
          ts.isPropertyDeclaration(n)) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        /^z\s*\./.test(this.src(n.initializer))
      )
        names.add(n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    return names;
  }

  isImportSpecifierName(id) {
    return (
      id.parent &&
      (ts.isImportSpecifier(id.parent) || ts.isImportClause(id.parent))
    );
  }

  convertRoot(n) {
    this.conversions += 1;
    if (ts.isTypeReferenceNode(n)) return this.convertType(n);
    if (ts.isExpressionWithTypeArguments(n)) return this.convertHeritage(n);
    return this.chain(n).text;
  }

  // ---- types -------------------------------------------------------------

  typeArgs(n) {
    return (n.typeArguments ?? []).map((t) => this.emit(t));
  }

  convertType(n) {
    const name = n.typeName.right.text;
    const args = this.typeArgs(n);
    const raw = this.src(n);
    const typeOfArg = (a) => {
      const m = /^typeof\s+([\w.$]+)$/.exec(a);
      return m ? m[1] : null;
    };
    switch (name) {
      case 'infer':
      case 'output': {
        const t = typeOfArg(args[0] ?? '');
        return t ? `typeof ${t}.Type` : `(${args[0]})['Type']`;
      }
      case 'input': {
        const t = typeOfArg(args[0] ?? '');
        return t ? `typeof ${t}.Encoded` : `(${args[0]})['Encoded']`;
      }
      case 'ZodType':
      case 'ZodSchema':
      case 'ZodTypeAny':
        if (args.length === 0) return 'Schema.Top';
        return `Schema.Codec<${args.join(', ')}>`;
      case 'ZodError':
        return 'Schema.SchemaError';
      case 'ZodSafeParseResult':
      case 'SafeParseReturnType':
        this.needs.add('Result');
        return `Result.Result<${args[0] ?? 'unknown'}, Schema.SchemaError>`;
      case 'ZodIssue':
        this.needs.add('SchemaIssue');
        return 'SchemaIssue.Issue';
      case 'RefinementCtx':
        return this.todo(
          'RefinementCtx: the filter returns a FilterOutput instead',
          raw,
          'never',
        );
      case 'ZodObject':
        return this.todo(
          'ZodObject type',
          raw,
          'Schema.Struct<Schema.Struct.Fields>',
        );
      default:
        return this.todo(`type z.${name}`, raw, 'unknown');
    }
  }

  convertHeritage(n) {
    return this.todo('heritage clause', this.src(n), this.src(n));
  }

  // ---- expressions -------------------------------------------------------

  /** Flatten a chain into its bottom and ordered links. */
  links(n) {
    const out = [];
    let cur = n;
    while (true) {
      if (ts.isNonNullExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (
        ts.isCallExpression(cur) &&
        ts.isPropertyAccessExpression(cur.expression)
      ) {
        out.unshift({
          name: cur.expression.name.text,
          call: cur,
          args: cur.arguments,
          typeArgs: cur.typeArguments,
        });
        cur = cur.expression.expression;
        continue;
      }
      if (ts.isCallExpression(cur)) {
        out.unshift({
          name: null,
          call: cur,
          args: cur.arguments,
          typeArgs: cur.typeArguments,
        });
        cur = cur.expression;
        continue;
      }
      if (ts.isPropertyAccessExpression(cur)) {
        out.unshift({
          name: cur.name.text,
          call: null,
          args: [],
          typeArgs: undefined,
        });
        cur = cur.expression;
        continue;
      }
      return { bottom: cur, links: out };
    }
  }

  arg(a) {
    return this.emit(a);
  }

  /** Convert a whole chain; returns { text, kind }. */
  chain(n) {
    const { bottom, links } = this.links(n);
    let state;
    let i = 0;
    if (ts.isIdentifier(bottom) && bottom.text === 'z') {
      const first = links[0];
      i = 1;
      state = this.base(first, links, () => (i += 1));
    } else {
      state = { text: this.emit(bottom), kind: 'unknown' };
    }
    for (; i < links.length; i += 1) state = this.method(state, links[i], n);
    return state;
  }

  objectFields(objNode) {
    if (!ts.isObjectLiteralExpression(objNode)) return this.emit(objNode);
    return this.within(objNode).replace(/\.shape\b/g, '.fields');
  }

  base(link, links, skip) {
    const raw = `z.${link.name}(${[...link.args].map((a) => this.src(a)).join(', ')})`;
    const args = [...link.args];
    const A = (k) => this.arg(args[k]);
    switch (link.name) {
      case 'object':
      case 'strictObject':
        return {
          text: `Schema.Struct(${this.objectFields(args[0])})`,
          kind: 'object',
        };
      case 'looseObject':
        return {
          text: `Schema.StructWithRest(Schema.Struct(${this.objectFields(args[0])}), [Schema.Record(Schema.String, Schema.Unknown)])`,
          kind: 'object',
        };
      case 'literal':
        return ts.isArrayLiteralExpression(args[0])
          ? { text: `Schema.Literals(${A(0)})`, kind: 'literal' }
          : { text: `Schema.Literal(${A(0)})`, kind: 'literal' };
      case 'enum':
        return ts.isArrayLiteralExpression(args[0])
          ? { text: `Schema.Literals(${A(0)})`, kind: 'literal' }
          : { text: `Schema.Enum(${A(0)})`, kind: 'literal' };
      case 'nativeEnum':
        return { text: `Schema.Enum(${A(0)})`, kind: 'literal' };
      case 'array':
        return { text: `Schema.Array(${A(0)})`, kind: 'array' };
      case 'record':
        return args.length === 1
          ? { text: `Schema.Record(Schema.String, ${A(0)})`, kind: 'record' }
          : { text: `Schema.Record(${A(0)}, ${A(1)})`, kind: 'record' };
      case 'tuple':
        return { text: `Schema.Tuple(${A(0)})`, kind: 'tuple' };
      case 'union':
        return { text: `Schema.Union(${A(0)})`, kind: 'union' };
      case 'discriminatedUnion':
        return { text: `Schema.Union(${A(1)})`, kind: 'union' };
      case 'intersection':
        return {
          text: this.todo('intersection', raw, `Schema.Struct({})`),
          kind: 'object',
        };
      case 'lazy':
        return { text: `Schema.suspend(${A(0)})`, kind: 'unknown' };
      case 'instanceof':
        return { text: `Schema.instanceOf(${A(0)})`, kind: 'unknown' };
      case 'custom': {
        const t = link.typeArgs ? `<${this.within(link.typeArgs[0])}>` : '';
        const guard = args[0]
          ? A(0)
          : `(_u): _u is ${t ? this.within(link.typeArgs[0]) : 'unknown'} => true`;
        return { text: `Schema.declare${t}(${guard})`, kind: 'unknown' };
      }
      case 'map':
        return {
          text: `Schema.ReadonlyMap(${A(0)}, ${A(1)})`,
          kind: 'unknown',
        };
      case 'set':
        return { text: `Schema.ReadonlySet(${A(0)})`, kind: 'unknown' };
      case 'coerce': {
        // z.coerce.number() → the next link is the primitive.
        const next = links[1];
        skip();
        return {
          text: this.todo(
            `z.coerce.${next?.name}`,
            `z.coerce.${next?.name}()`,
            ZERO_ARG_BASES[next?.name] ?? 'Schema.Unknown',
          ),
          kind: BASE_KIND[next?.name] ?? 'unknown',
        };
      }
      case 'iso': {
        const next = links[1];
        skip();
        return {
          text: this.todo(
            `z.iso.${next?.name}`,
            `z.iso.${next?.name}()`,
            'Schema.String',
          ),
          kind: 'string',
        };
      }
      case 'preprocess':
        return { text: this.todo('preprocess', raw, A(1)), kind: 'unknown' };
      case 'prettifyError':
        return { text: `${A(0)}.message`, kind: 'value' };
      case 'toJSONSchema':
        return {
          text: this.todo(
            'toJSONSchema',
            raw,
            `Schema.toJsonSchemaDocument(${A(0)}).schema`,
          ),
          kind: 'value',
        };
      case 'fromJSONSchema':
        this.needs.add('SchemaRepresentation').add('JsonSchema');
        return {
          text: this.todo(
            'fromJSONSchema',
            raw,
            `SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(${A(0)}))`,
          ),
          kind: 'unknown',
        };
      case 'ZodError':
        return { text: 'Schema.SchemaError', kind: 'value' };
      case 'core':
        return { text: this.todo('z.core', raw, 'SchemaIssue'), kind: 'value' };
      case 'url':
      case 'email':
      case 'base64':
      case 'base64url':
      case 'hostname':
      case 'ipv4':
      case 'ipv6':
      case 'jwt':
      case 'ulid':
      case 'cuid':
      case 'nanoid':
      case 'emoji':
        return {
          text: this.todo(
            `z.${link.name}: add the string check`,
            raw,
            'Schema.String',
          ),
          kind: 'string',
        };
      default:
        if (link.name in ZERO_ARG_BASES && args.length === 0)
          return {
            text: ZERO_ARG_BASES[link.name],
            kind: BASE_KIND[link.name] ?? 'unknown',
          };
        return {
          text: this.todo(`z.${link.name}`, raw, 'Schema.Unknown'),
          kind: 'unknown',
        };
    }
  }

  method(state, link, root) {
    const R = state.text;
    const args = [...link.args];
    const A = (k) => this.arg(args[k]);
    const raw = `.${link.name}(${args.map((a) => this.src(a)).join(', ')})`;
    const keep = (kind) => ({
      text: `${R}${this.todo(link.name, raw, '')}`,
      kind,
    });
    const check = (c) => ({ ...state, text: `${R}.check(${c})` });
    const effect = () => this.needs.add('Effect');
    switch (link.name) {
      case 'optional':
        return { ...state, text: `Schema.optional(${R})` };
      case 'nullable':
        return { ...state, text: `Schema.NullOr(${R})` };
      case 'nullish':
        return { ...state, text: `Schema.optional(Schema.NullOr(${R}))` };
      case 'readonly':
      case 'strict':
      case 'strip':
        return state;
      case 'loose':
      case 'passthrough':
        return {
          ...state,
          text: `Schema.StructWithRest(${R}, [Schema.Record(Schema.String, Schema.Unknown)])`,
        };
      case 'describe':
        return { ...state, text: `${R}.annotate({ description: ${A(0)} })` };
      case 'meta':
        return { ...state, text: `${R}.annotate(${A(0)})` };
      case 'array':
        return { text: `Schema.Array(${R})`, kind: 'array' };
      case 'default':
        effect();
        return {
          ...state,
          text: `${R}.pipe(Schema.withDecodingDefaultType(Effect.succeed(${A(0)})))`,
        };
      case 'prefault':
        effect();
        return {
          ...state,
          text: `${R}.pipe(Schema.withDecodingDefault(Effect.succeed(${A(0)})))`,
        };
      case 'catch':
        effect();
        this.needs.add('Option');
        return {
          ...state,
          text: `${R}.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(${A(0)}))))`,
        };
      case 'brand': {
        const t = link.typeArgs?.[0];
        if (t && ts.isLiteralTypeNode(t))
          return { ...state, text: `${R}.pipe(Schema.brand(${this.src(t)}))` };
        if (args[0])
          return { ...state, text: `${R}.pipe(Schema.brand(${A(0)}))` };
        return keep(state.kind);
      }
      case 'min':
      case 'gte':
        return state.kind === 'number'
          ? check(`Schema.isGreaterThanOrEqualTo(${A(0)})`)
          : check(`Schema.isMinLength(${A(0)})`);
      case 'max':
      case 'lte':
        return state.kind === 'number'
          ? check(`Schema.isLessThanOrEqualTo(${A(0)})`)
          : check(`Schema.isMaxLength(${A(0)})`);
      case 'gt':
        return check(`Schema.isGreaterThan(${A(0)})`);
      case 'lt':
        return check(`Schema.isLessThan(${A(0)})`);
      case 'positive':
        return check('Schema.isGreaterThan(0)');
      case 'nonnegative':
        return check('Schema.isGreaterThanOrEqualTo(0)');
      case 'negative':
        return check('Schema.isLessThan(0)');
      case 'nonpositive':
        return check('Schema.isLessThanOrEqualTo(0)');
      case 'int':
        return R === 'Schema.Number'
          ? { text: 'Schema.Int', kind: 'number' }
          : check('Schema.isInt()');
      case 'finite':
        return R === 'Schema.Number'
          ? { text: 'Schema.Finite', kind: 'number' }
          : check('Schema.isFinite()');
      case 'multipleOf':
        return check(`Schema.isMultipleOf(${A(0)})`);
      case 'length':
        return check(
          `Schema.isMinLength(${A(0)}), Schema.isMaxLength(${A(0)})`,
        );
      case 'nonempty':
        if (state.kind === 'array') {
          const m = /^Schema\.Array\((.*)\)$/s.exec(R);
          if (m)
            return { text: `Schema.NonEmptyArray(${m[1]})`, kind: 'array' };
        }
        if (R === 'Schema.String')
          return { text: 'Schema.NonEmptyString', kind: 'string' };
        return check('Schema.isNonEmpty()');
      case 'trim':
        return R === 'Schema.String'
          ? { text: 'Schema.Trim', kind: 'string' }
          : keep(state.kind);
      case 'regex':
        return check(`Schema.isPattern(${A(0)})`);
      case 'startsWith':
        return check(`Schema.isStartingWith(${A(0)})`);
      case 'endsWith':
        return check(`Schema.isEndingWith(${A(0)})`);
      case 'includes':
        return check(`Schema.isIncluding(${A(0)})`);
      case 'uuid':
        return check('Schema.isUUID()');
      case 'url':
      case 'email':
      case 'toLowerCase':
      case 'toUpperCase':
      case 'safe':
        return keep(state.kind);
      case 'extend':
        this.needs.add('Struct');
        return {
          ...state,
          text: `${R}.mapFields(Struct.assign(${this.objectFields(args[0])}))`,
        };
      case 'merge':
        this.needs.add('Struct');
        return {
          ...state,
          text: `${R}.mapFields(Struct.assign(${A(0)}.fields))`,
        };
      case 'pick':
      case 'omit': {
        this.needs.add('Struct');
        const keys = this.maskKeys(args[0]);
        return keys
          ? { ...state, text: `${R}.mapFields(Struct.${link.name}(${keys}))` }
          : keep(state.kind);
      }
      case 'partial':
        this.needs.add('Struct');
        return args.length === 0
          ? { ...state, text: `${R}.mapFields(Struct.map(Schema.optional))` }
          : keep(state.kind);
      case 'required':
        this.needs.add('Struct');
        return args.length === 0
          ? { ...state, text: `${R}.mapFields(Struct.map(Schema.required))` }
          : keep(state.kind);
      case 'shape':
        return { ...state, text: `${R}.fields` };
      case 'options':
        return { ...state, text: `${R}.members` };
      case 'refine': {
        const ann = this.filterAnnotations(args[1]);
        return check(`Schema.makeFilter(${A(0)}${ann})`);
      }
      case 'superRefine':
        return {
          ...state,
          text: `${R}.check(Schema.makeFilter(${this.todo('superRefine: return FilterOutput instead of ctx.addIssue', raw, A(0))}))`,
        };
      case 'transform':
        this.needs.add('SchemaGetter');
        return {
          ...state,
          kind: 'unknown',
          text: `${R}.pipe(Schema.decodeTo(${this.todo('transform target schema', raw, 'Schema.Unknown')}, { decode: SchemaGetter.transform(${A(0)}), encode: SchemaGetter.forbidden(() => 'decode-only') }))`,
        };
      case 'pipe':
        return {
          ...state,
          kind: 'unknown',
          text: `${R}.pipe(Schema.decodeTo(${A(0)}))`,
        };
      case 'parse':
        return {
          text: `Schema.decodeUnknownSync(${R})(${A(0)})`,
          kind: 'value',
        };
      case 'safeParse':
        return {
          text: `Schema.decodeUnknownResult(${R})(${A(0)})`,
          kind: 'value',
        };
      case 'parseAsync':
        return {
          text: `Schema.decodeUnknownPromise(${R})(${A(0)})`,
          kind: 'value',
        };
      case 'safeParseAsync':
        return {
          text: this.todo(
            'safeParseAsync',
            raw,
            `Schema.decodeUnknownPromise(${R})(${A(0)})`,
          ),
          kind: 'value',
        };
      case 'and':
      case 'or':
      case 'keyof':
      case 'catchall':
      case 'element':
      case 'unwrap':
      case 'check':
      case 'overwrite':
      case 'register':
      case 'def':
      case '_def':
      case '_zod':
        return keep(state.kind);
      default:
        // A plain property read (`XSchema.fields.name`) is not a Zod method;
        // an unknown call is kept for the hand pass.
        if (link.call === null) return { ...state, text: `${R}.${link.name}` };
        return keep(state.kind);
    }
  }

  maskKeys(obj) {
    if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
    const keys = [];
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))
        return null;
      const name = p.name;
      keys.push(ts.isIdentifier(name) ? `'${name.text}'` : this.src(name));
    }
    return `[${keys.join(', ')}]`;
  }

  filterAnnotations(a) {
    if (!a) return '';
    if (ts.isStringLiteralLike(a)) return `, { message: ${this.src(a)} }`;
    return `, ${this.emit(a)}`;
  }
}

// ---- imports -----------------------------------------------------------

function rewriteImports(text, sf, needs) {
  const edits = [];
  let effectImport = null;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = st.moduleSpecifier.text;
    if (spec === 'zod' || spec.startsWith('zod/')) {
      let end = st.getEnd();
      if (text[end] === '\n') end += 1;
      edits.push([st.getStart(sf), end, '']);
    }
    if (
      spec === 'effect' &&
      !st.importClause?.isTypeOnly &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings)
    )
      effectImport = st;
  }
  if (effectImport) {
    const nb = effectImport.importClause.namedBindings;
    const have = new Set(nb.elements.map((e) => e.name.text));
    const add = [...needs].filter((n) => !have.has(n));
    if (add.length) {
      const names = [
        ...nb.elements.map((e) => text.slice(e.getStart(sf), e.getEnd())),
        ...add,
      ].sort((a, b) =>
        a.replace(/^type /, '').localeCompare(b.replace(/^type /, '')),
      );
      edits.push([nb.getStart(sf), nb.getEnd(), `{ ${names.join(', ')} }`]);
    }
  } else {
    const first = sf.statements.find((s) => ts.isImportDeclaration(s));
    const at = first ? first.getStart(sf) : 0;
    edits.push([
      at,
      at,
      `import { ${[...needs].sort().join(', ')} } from 'effect';\n`,
    ]);
  }
  return edits;
}

function applyEdits(text, edits) {
  let out = text;
  for (const [s, e, t] of edits.sort((a, b) => b[0] - a[0]))
    out = out.slice(0, s) + t + out.slice(e);
  return out;
}

// ---- driver ------------------------------------------------------------

function* files(paths) {
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) {
        if (e === 'node_modules' || e === 'dist') continue;
        yield* files([join(p, e)]);
      }
    } else if (
      ['.ts', '.tsx', '.mts'].includes(extname(p)) &&
      !p.endsWith('.d.ts')
    )
      yield p;
  }
}

let totalFiles = 0;
let totalConv = 0;
let totalTodo = 0;
for (const file of files(process.argv.slice(2))) {
  const text = readFileSync(file, 'utf8');
  if (!/from ['"]zod/.test(text)) continue;
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const c = new Converter(sf, text);
  const body = c.within(sf);
  // `core.$ZodIssue` from `import { type core } from 'zod'`.
  const fixed = body
    .replace(
      /\bcore\.\$ZodIssue\b/g,
      () => (c.needs.add('SchemaIssue'), 'SchemaIssue.Issue'),
    )
    .replace(
      /\bcore\.\$ZodAsyncError\b/g,
      () => (c.needs.add('SchemaIssue'), 'never'),
    )
    .replace(
      /\btoJSONSchema\(/g,
      (m) => (
        (c.todos += 1),
        `Schema.toJsonSchemaDocument(/* ${TODO}: toJSONSchema */ `
      ),
    );
  const sf2 = ts.createSourceFile(
    file,
    fixed,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out = applyEdits(fixed, rewriteImports(fixed, sf2, c.needs));
  writeFileSync(file, out);
  totalFiles += 1;
  totalConv += c.conversions;
  totalTodo += c.todos;
  console.log(`${file}: ${c.conversions} converted, ${c.todos} to review`);
}
console.log(
  `\n${totalFiles} files, ${totalConv} conversions, ${totalTodo} markers`,
);
