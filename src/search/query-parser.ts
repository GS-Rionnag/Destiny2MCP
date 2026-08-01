/*
 * Ported from Destiny Item Manager (https://github.com/DestinyItemManager/DIM),
 * src/app/search/query-parser.ts — MIT License, Copyright (c) 2018 Destiny Item Manager.
 *
 * Trimmed to the lexer + parser. DIM's i18n, autocomplete and query-canonicalization
 * pieces are dropped; the grammar and operator precedence are unchanged, so a query that
 * parses in DIM parses identically here.
 *
 * Lazy BNF diagram of the search grammar
 * <query> ::= <term> | <term> <term>
 * <clause> ::= <opt-whitespace> <clause>
 * <terms> ::= <term> { " " <term>}
 * <term> ::= <string> | <filter> | <group> | <boolean>
 * <filter> ::= ["-"]<filterName>:<filterValue>[<operator><number>]
 * <filterName> ::= <the set of known filter names - is, stat, perk, etc.>
 * <filterValue> ::= <keyword> | "stat:" <statName> | <string>
 * <keyword> ::= <the set of known keyword filters - locked, sniperrifle, etc.>
 * <statName> ::= <the set of known stat keywords - impact, resilience, etc.>
 * <operator> ::= "none" | "=" | "<" | "<=" | ">" | ">="
 * <number> ::= DIGIT{DIGIT}
 * <group> ::= "(" <query> ")"
 * <boolean> ::= "or" | "not" | "and"
 * <string> ::= WORD | "\"" WORD {" " WORD} "\"" | "'" WORD {" " WORD} "'"
 */

interface QueryASTCommon {
  error?: Error;
  comment?: string;
  /** The beginning index of the query string where this was found. */
  startIndex: number;
  /** The length of the portion of the query string this operator consists of, including operands. */
  length: number;
}

export type QueryAST = AndOp | OrOp | NotOp | FilterOp | NoOp;

/** If ALL operands are true, this resolves to true. */
export interface AndOp extends QueryASTCommon {
  op: 'and';
  operands: QueryAST[];
}

/** If ANY operand is true, this resolves to true. */
export interface OrOp extends QueryASTCommon {
  op: 'or';
  operands: QueryAST[];
}

/** Negates the result of its only operand. */
export interface NotOp extends QueryASTCommon {
  op: 'not';
  operand: QueryAST;
}

/** One filter function invocation, such as is:, stat:, name:. */
export interface FilterOp extends QueryASTCommon {
  op: 'filter';
  /** Filter name without the trailing ':'. Bare words get the type 'keyword'. */
  type: string;
  /** Filter arguments as a single string, e.g. 'exotic', 'resilience:>=20'. */
  args: string;
}

/** Mostly for error cases and the empty string. */
export interface NoOp extends QueryASTCommon {
  op: 'noop';
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Generators can't peek without advancing, so buffer one element.
 */
class PeekableGenerator<T> {
  private gen: Generator<T>;
  private next: T | undefined;

  constructor(gen: Generator<T>) {
    this.gen = gen;
  }

  peek(): T | undefined {
    if (!this.next) {
      const n = this.gen.next();
      if (!n.done) this.next = n.value;
    }
    return this.next;
  }

  pop(): T | undefined {
    if (this.next) {
      const ret = this.next;
      this.next = undefined;
      return ret;
    }
    const n = this.gen.next();
    if (!n.done) return n.value;
  }
}

/**
 * Operator precedence. The implicit `and` (whitespace) binds looser than explicit `or`/`and`.
 */
const operators = {
  implicit_and: { precedence: 1, op: 'and' },
  or: { precedence: 2, op: 'or' },
  and: { precedence: 3, op: 'and' },
} as const;

/**
 * Lex the string, then parse it into an AST representing the logical structure of the query.
 * Precedence climbing: https://eli.thegreenplace.net/2012/08/02/parsing-expressions-by-precedence-climbing
 */
export function parseQuery(query: string): QueryAST {
  /** The next "atom": a filter, a group, or a `not` modifier on either. Never a binary operator. */
  function parseAtom(tokens: PeekableGenerator<Token>): QueryAST {
    const token: Token | undefined = tokens.pop();
    if (!token) throw new Error('expected an atom');

    switch (token.type) {
      case 'filter': {
        const keyword = token.keyword;
        if (keyword === 'not') {
          // `not:` is a synonym for `-is:`. Normalize it here rather than at execution.
          return {
            op: 'not',
            operand: {
              op: 'filter',
              type: 'is',
              args: token.args,
              startIndex: token.startIndex,
              length: token.length,
            },
            startIndex: token.startIndex,
            length: token.length,
          };
        }
        return {
          op: 'filter',
          type: keyword,
          args: token.args,
          startIndex: token.startIndex,
          length: token.length,
        };
      }
      case 'not': {
        const operand = parseAtom(tokens);
        return { op: 'not', operand, startIndex: token.startIndex, length: token.length + operand.length };
      }
      case '(': {
        const result = parse(tokens);
        result.length += result.startIndex - token.startIndex;
        result.startIndex = token.startIndex;
        if (tokens.peek()?.type === ')') {
          const closeParen = tokens.pop();
          result.length += closeParen!.length;
        }
        return result;
      }
      case 'comment': {
        const comment = token.content;
        const next = parseAtom(tokens);
        return { ...next, comment, startIndex: next.startIndex, length: next.length };
      }
      default:
        throw new Error(`Unexpected token type, looking for an atom: ${JSON.stringify(token)}, ${query}`);
    }
  }

  function parse(tokens: PeekableGenerator<Token>, minPrecedence = 1): QueryAST {
    let ast: QueryAST = { op: 'noop', startIndex: 0, length: 0 };

    try {
      ast = parseAtom(tokens);

      let token: Token | undefined;
      while ((token = tokens.peek())) {
        if (token.type === ')') break;
        const operator = operators[token.type as keyof typeof operators];
        if (!operator) throw new Error(`Expected an operator, got ${JSON.stringify(token)}`);
        else if (operator.precedence < minPrecedence) break;

        tokens.pop();
        const nextMinPrecedence = operator.precedence + 1; // all operators are left-associative
        const rhs = parse(tokens, nextMinPrecedence);

        // Operators allow more than 2 operands, to avoid deep logic trees.
        if (isSameOp(operator.op, ast)) {
          ast.operands.push(rhs);
          ast.length += rhs.length;
        } else {
          const title = ast.comment;
          delete ast.comment;
          ast = {
            op: operator.op,
            operands: isSameOp(operator.op, rhs) ? [ast, ...rhs.operands] : [ast, rhs],
            startIndex: Math.min(rhs.startIndex, ast.startIndex, token.startIndex),
            length: ast.length + rhs.length + token.length,
          };
          if (title) ast.comment = title;
        }
      }
    } catch (e) {
      ast.error = asError(e);
    }

    return ast;
  }

  const tokens = new PeekableGenerator(lexer(query));
  try {
    if (!tokens.peek()) return { op: 'noop', startIndex: 0, length: 0 };
  } catch (e) {
    return { op: 'noop', error: asError(e), startIndex: 0, length: 0 };
  }
  return parse(tokens);
}

function isSameOp<T extends 'and' | 'or'>(binOp: T, op: QueryAST): op is AndOp | OrOp {
  return binOp === op.op;
}

/* **** Lexer **** */

type NoArgTokenType = '(' | ')' | 'not' | 'or' | 'and' | 'implicit_and';
export type Token = { startIndex: number; length: number; quoted?: boolean } & (
  | { type: NoArgTokenType }
  | { type: 'filter'; keyword: string; args: string }
  | { type: 'comment'; content: string }
);

// Parens: `(` can be followed by whitespace, `)` can be preceded by it
const parens = /(\(\s*|\s*\))/y;
// A `-` followed by any amount of whitespace is the same as "not"
const negation = /-\s*/y;
// `not`, `or`, `and`. `not` can't be preceded by whitespace — that whitespace is an implicit `and`.
const booleanKeywords = /(not|\s+or|\s+and)\s+/y;
const filterName = /[a-z]+:/y;
const filterArgs = /[^\s()]+/y;
const bareWords = /[^\s)]+/y;
const whitespace = /\s+/y;
const comment = /\/\*(.*?)\*\/\s*/y;

// Turn smart-quote variants into their ASCII equivalents before parsing.
const singleQuoteLike = /[‘-‚]/g;
const doubleQuoteLike = /[“-„]/g;
const normalizeQuotes = (str: string) => str.replace(singleQuoteLike, "'").replace(doubleQuoteLike, '"');

export class QueryLexerError extends Error {
  startIndex: number;
  length: number;

  constructor(message: string, startIndex: number, length: number) {
    super(message);
    this.startIndex = startIndex;
    this.length = length;
    this.name = 'QueryLexerError';
  }
}

/** A QueryLexerError for unclosed quotes. */
export class QueryLexerOpenQuotesError extends QueryLexerError {}

/**
 * Yields tokens representing the linear structure of the query. Throws on invalid input.
 *
 * Example: "is:blue -is:masterwork" turns into:
 * ["filter", "is", "blue"], ["implicit_and"], ["not"], ["filter", "is", "masterwork"]
 */
export function* lexer(query: string): Generator<Token> {
  query = normalizeQuotes(query.toLowerCase());

  let match: string | undefined;
  let i = 0;

  const consume = (str: string) => (i += str.length);

  /**
   * If `query` matches `re` starting at `i`, return the matched portion. Regexes must be sticky (y)
   * and must not use ^, which would match the beginning of the whole string.
   */
  const extract = (re: RegExp): string | undefined => {
    re.lastIndex = i;
    const m = re.exec(query);
    if (m) {
      const result = m[0];
      if (result.length > 0) {
        consume(result);
        return m.length > 1 ? m[1] : result;
      }
    }
    return undefined;
  };

  const consumeString = (startingQuoteChar: string) => {
    const initial = i;
    consume(startingQuoteChar);
    let str = '';
    while (i < query.length) {
      const char = query[i];
      consume(char);
      // Character escapes: \", \', \\
      if (char === '\\') {
        const escapeStart = i;
        if (i < query.length) {
          const escaped = query[i];
          if (escaped === '"' || escaped === "'" || escaped === '\\') {
            str += escaped;
            consume(escaped);
          } else {
            throw new QueryLexerError(`Unrecognized escape sequence \\${escaped}`, escapeStart, i - escapeStart);
          }
        } else {
          str = str + char;
        }
      } else if (char === startingQuoteChar) {
        return str;
      } else {
        str = str + char;
      }
    }

    throw new QueryLexerOpenQuotesError(`Unterminated quotes: |${query.slice(initial)}| ${initial}`, initial, i - initial);
  };

  while (i < query.length) {
    const char = query[i];
    const startIndex = i;

    if ((match = extract(parens)) !== undefined) {
      yield { startIndex, length: i - startIndex, type: match.trim() as NoArgTokenType };
    } else if (char === '"' || char === "'") {
      const quotedString = consumeString(char);
      yield { startIndex, length: i - startIndex, type: 'filter', keyword: 'keyword', args: quotedString, quoted: true };
    } else if (extract(negation) !== undefined) {
      yield { startIndex, length: i - startIndex, type: 'not' };
    } else if ((match = extract(booleanKeywords)) !== undefined) {
      yield { startIndex, length: i - startIndex, type: match.trim() as NoArgTokenType };
    } else if ((match = extract(comment)) !== undefined) {
      yield { startIndex, length: i - startIndex, type: 'comment', content: match.trim() };
    } else if ((match = extract(filterName)) !== undefined) {
      // Keyword searches: is:, stat:discipline:, etc
      const keyword = match.slice(0, match.length - 1);
      const nextChar = query[i];

      let args: string;
      let quoted = false;

      if (nextChar === '"' || nextChar === "'") {
        try {
          quoted = true;
          args = consumeString(nextChar);
        } catch (e) {
          if (e instanceof QueryLexerOpenQuotesError) {
            // Rethrow including the filter prefix (e.g. name:) in the range
            throw new QueryLexerOpenQuotesError(e.message, startIndex, e.length + match.length);
          }
          throw e;
        }
      } else if ((match = extract(filterArgs)) !== undefined) {
        args = match;
      } else {
        throw new QueryLexerError(`missing keyword arguments for ${keyword}`, startIndex, query.length - startIndex);
      }

      yield { startIndex, length: i - startIndex, type: 'filter', keyword, args, quoted };
    } else if ((match = extract(bareWords)) !== undefined) {
      // Bare words that aren't keywords act as "keyword" type filters
      yield { startIndex, length: i - startIndex, type: 'filter', keyword: 'keyword', args: match };
    } else if (extract(whitespace) !== undefined) {
      // Ignore whitespace at the beginning and end of the string
      if (startIndex !== 0 && i !== query.length) {
        yield { startIndex, length: i - startIndex, type: 'implicit_and' };
      }
    } else {
      throw new QueryLexerError(`unrecognized tokens: |${query.slice(i)}| ${i}`, startIndex, query.length - startIndex);
    }

    if (startIndex === i) throw new Error('bug: forgot to consume characters');
  }
}
