/**
 * MapLibre iOS sets layer properties by converting the style expression to an
 * NSExpression and back to JSON. That round trip loses a compound condition
 * (`!`, `all`, `any`) used in a `case` with more than one condition: it comes
 * back as a raw NSPredicate object, MapLibre rejects the property with
 * "Invalid property value" and, because it happens while the style loads, the
 * app aborts. Android and web parse the JSON directly and are not affected,
 * and layer `filter`s take a different path that handles them fine.
 *
 * A `case` with exactly one condition is converted differently and is safe.
 * Rewrite affected conditions as comparisons (`['==', ['has', 'x'], false]`)
 * or reorder the branches so the condition is positive.
 *
 * iosUnsafeCaseConditions lists the offending conditions (as JSON paths) so
 * tests can guard the shared expressions native uses in layout/paint.
 */

const COMPOUND = new Set(['!', 'all', 'any', 'none'])

export function iosUnsafeCaseConditions(expr: unknown, path = '$'): string[] {
  if (!Array.isArray(expr)) return []
  const found: string[] = []
  if (expr[0] === 'case' && expr.length > 4) {
    // ['case', c1, v1, c2, v2, ..., fallback]: conditions at odd indexes.
    for (let i = 1; i < expr.length - 1; i += 2) {
      const cond = expr[i]
      if (Array.isArray(cond) && COMPOUND.has(cond[0] as string)) found.push(`${path}[${i}]`)
    }
  }
  if (expr[0] === 'literal') return found
  expr.forEach((child, i) => { found.push(...iosUnsafeCaseConditions(child, `${path}[${i}]`)) })
  return found
}
