/**
 * Rewrites CSS colour literals found inside a MapLibre expression into the
 * explicit `['rgba', r, g, b, a]` form.
 *
 * Why: colour strings used as *outputs* of `case` / `match` expressions are
 * left as plain NSString constants by MapLibre RN's iOS style bridge, and the
 * iOS core has been observed to throw a C++ exception (app abort) when such an
 * expression is assigned to a colour property, whereas Android's parser
 * tolerates it. The explicit `rgba` expression is unambiguous on both
 * platforms. A plain top-level colour string (not inside an expression) is
 * handled by the bridge separately and is left untouched.
 *
 * Only strings that look like colours are rewritten, so operands such as
 * `['==', ['get', 'class'], 'C']` are unaffected.
 */
type Expr = unknown

const RGBA_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function parseColorLiteral(s: string): [number, number, number, number] | null {
  const t = s.trim()
  const m = RGBA_RE.exec(t)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  const h = HEX_RE.exec(t)
  if (h) {
    let x = h[1]
    if (x.length <= 4) x = x.split('').map(c => c + c).join('')
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), x.length === 8 ? Number((n(6) / 255).toFixed(3)) : 1]
  }
  return null
}

const NON_COLOR_OPS = new Set(['==', '!=', 'in', 'get', 'has', '!has', '!in'])

/** Recursively rewrite colour literals inside an expression array. */
export function colorExpr<T extends Expr>(expr: T): T {
  if (!Array.isArray(expr)) return expr
  // Literal wrappers must not be rewritten: ['literal', [...]]
  if (expr[0] === 'literal') return expr
  // Operands of these operators are data comparisons, never colour outputs.
  const operandOnly = typeof expr[0] === 'string' && NON_COLOR_OPS.has(expr[0])
  return expr.map(node => {
    if (typeof node === 'string' && !operandOnly) {
      const c = parseColorLiteral(node)
      return c ? ['rgba', ...c] : node
    }
    return Array.isArray(node) ? colorExpr(node) : node
  }) as unknown as T
}
