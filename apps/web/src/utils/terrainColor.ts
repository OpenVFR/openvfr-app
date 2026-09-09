import type { ExpressionSpecification } from 'maplibre-gl'
import { buildTerrainColorExpr as buildTerrainColorExprShared } from '@open-vfr/shared/terrainColor'

/**
 * Web wrapper around the shared expression builder (packages/shared/src/terrainColor.ts)
 * — casts to maplibre-gl's ExpressionSpecification type. Native (AviationMap.tsx)
 * imports the shared function directly since its MapLibre binding uses a
 * different (compatible) expression type.
 */
export function buildTerrainColorExpr(refAltFt: number): ExpressionSpecification {
  return buildTerrainColorExprShared(refAltFt) as ExpressionSpecification
}
