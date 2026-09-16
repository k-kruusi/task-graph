type Expr =
  | { type: "literal"; value: unknown }
  | { type: "path"; segments: string[] }
  | { type: "unary"; op: "!"; operand: Expr }
  | { type: "binary"; op: "===" | "!==" | "&&" | "||"; left: Expr; right: Expr };

const TOKEN_RE = /\s*(===|!==|&&|\|\||!|\(|\)|true|false|null|undefined|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*/g;

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(expr)) !== null) {
    if (match.index !== lastIndex) {
      throw new Error(`Unexpected character at position ${lastIndex}: "${expr[lastIndex]}"`);
    }
    tokens.push(match[1]);
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex !== expr.length) {
    throw new Error(`Unexpected trailing: "${expr.slice(lastIndex)}"`);
  }
  return tokens;
}

function parseLiteral(token: string): { type: "literal"; value: unknown } | null {
  if (token === "true") return { type: "literal", value: true };
  if (token === "false") return { type: "literal", value: false };
  if (token === "null") return { type: "literal", value: null };
  if (token === "undefined") return { type: "literal", value: undefined };
  if (/^-?\d+(\.\d+)?$/.test(token)) return { type: "literal", value: Number(token) };
  if (/^["']/.test(token)) return { type: "literal", value: token.slice(1, -1) };
  return null;
}

class Parser {
  private pos = 0;
  constructor(private tokens: string[]) {}

  parse(): Expr {
    const expr = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token: "${this.tokens[this.pos]}"`);
    }
    return expr;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private consume(expected?: string): string {
    const token = this.tokens[this.pos];
    if (expected && token !== expected) {
      throw new Error(`Expected "${expected}", got "${token || "EOF"}"`);
    }
    this.pos++;
    return token;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek() === "||") {
      this.consume();
      const right = this.parseAnd();
      left = { type: "binary", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.peek() === "&&") {
      this.consume();
      const right = this.parseEquality();
      left = { type: "binary", op: "&&", left, right };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseUnary();
    while (this.peek() === "===" || this.peek() === "!==") {
      const op = this.consume() as "===" | "!==";
      const right = this.parseUnary();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek() === "!") {
      this.consume();
      const operand = this.parseUnary();
      return { type: "unary", op: "!", operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    if (!token) throw new Error("Unexpected end of expression");

    if (token === "(") {
      this.consume();
      const expr = this.parseOr();
      this.consume(")");
      return expr;
    }

    this.consume();
    const lit = parseLiteral(token);
    if (lit) return lit;

    if (/^[a-zA-Z_]/.test(token)) {
      return { type: "path", segments: token.split(".") };
    }

    throw new Error(`Unexpected token: "${token}"`);
  }
}

function evaluate(expr: Expr, scope: Record<string, unknown>): unknown {
  switch (expr.type) {
    case "literal":
      return expr.value;
    case "path": {
      let current: unknown = scope;
      for (const seg of expr.segments) {
        if (current == null || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[seg];
      }
      return current;
    }
    case "unary":
      return !evaluate(expr.operand, scope);
    case "binary": {
      const left = evaluate(expr.left, scope);
      const right = evaluate(expr.right, scope);
      switch (expr.op) {
        case "===": return left === right;
        case "!==": return left !== right;
        case "&&": return left && right;
        case "||": return left || right;
      }
    }
  }
}

export type CompiledCondition = (scope: Record<string, unknown>) => boolean;

export function compileCondition(expr: string): CompiledCondition {
  const tokens = tokenize(expr);
  const ast = new Parser(tokens).parse();
  return (scope) => !!evaluate(ast, scope);
}
