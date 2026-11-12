/**
 * MCP tools for the pilot's saved places (named positions such as a cabin or
 * a farm strip; used in routes as PL/<name>): list, get, create, update
 * (never delete). Places carry no "check before use" mark: the routes that
 * use one are marked, and the guide tells the pilot to check a place.
 */
import * as z from 'zod'
import type { UserWaypointDocType } from '@open-vfr/shared/types'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { fmtCoord, resolveRoutePoints } from '@open-vfr/shared/routeIdentifiers'
import { allPoints, pointsNearPosition } from '@open-vfr/shared/pointsNear'
import { quote, QUOTE_NOTE } from './untrusted'
import { buildPlace, PLAIN_PLACE } from './placeTools'
import { fail, text, type Ctx, type Text } from './mcpContext'

export function registerPlaceTools(c: Ctx): void {
  const { caller } = c

  const placeLine = (p: UserWaypointDocType) => `- ${quote(p.name, 60)}${p.folder ? ` [folder ${quote(p.folder, 40)}]` : ''}: ${fmtCoord(p.lat, p.lng)} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}); ${PLAIN_PLACE.test(p.name) ? `route point PL/${p.name}` : 'name has unusual characters: ask the pilot to rename it before use in a route'}`

  c.tool('list_places', {
    description: "List the pilot's saved places (own named positions such as a cabin, a strip or a lake) with position and folder. With near (an identifier such as ESSB, or coordinates) they are sorted by distance from it and show it in NM: use that to answer which place is closest, never estimate distances yourself. Use a place in create_route / update_route / points_near as PL/<name>.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      folder: z.string().max(40).optional().describe('Only this folder'),
      near: z.string().min(2).max(60).optional().describe('Sort by distance from this point: an identifier (ESSB, ARL) or coordinates (5939N01756E)'),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  }, async ({ folder, near, limit }) => {
    if (!c.canRoutes) return c.noRoutes()
    const got = await c.places()
    if ('error' in got) return got.error
    let list = got
    let dist = new Map<string, number>()
    if (near) {
      const idx = await c.publicPointIndex()
      if (!idx) return fail('Aerodrome and navaid data is not available right now.')
      const centre = resolveRoutePoints([near], idx)[0]!
      if (!centre.ok) return fail(`${quote(near, 60)}: ${centre.reason}.`)
      dist = new Map(list.map(p => [p.id, distanceNm(centre.point, p)]))
      list = [...list].sort((a, b) => dist.get(a.id)! - dist.get(b.id)!)
    }
    if (folder !== undefined) list = list.filter(p => p.folder.toLowerCase() === folder.trim().toLowerCase())
    if (list.length === 0) return text(folder !== undefined ? `No saved places in folder ${quote(folder, 40)}.` : 'No saved places.')
    const n = limit ?? 100
    return text(`Saved places (${list.length}):\n${list.slice(0, n).map(p => placeLine(p) + (dist.has(p.id) ? `; ${dist.get(p.id)!.toFixed(1)} NM from ${quote(near ?? '', 40)}` : '')).join('\n')}${list.length > n ? `\n… ${list.length - n} more: narrow with folder or raise limit.` : ''}\n${QUOTE_NOTE}`)
  })

  c.tool('get_place', {
    description: "One of the pilot's saved places: position, folder and the nearest aerodromes.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ name: z.string().min(1).max(60).describe('Place name (or part of it) or id') }),
  }, async ({ name }) => {
    if (!c.canRoutes) return c.noRoutes()
    const got = await c.places()
    if ('error' in got) return got.error
    const k = name.trim().toLowerCase()
    const hits = got.filter(p => p.id === name.trim() || p.name.toLowerCase() === k)
    const found = hits.length ? hits : got.filter(p => p.name.toLowerCase().includes(k))
    if (found.length === 0) return fail(`No saved place ${quote(name, 60)}. Use list_places.`)
    if (found.length > 1) return fail(`Several places match: ${found.slice(0, 8).map(p => quote(p.name, 60)).join(', ')}. Use the full name.\n${QUOTE_NOTE}`)
    const p = found[0]!
    const idx = await c.publicPointIndex()
    const near = idx ? pointsNearPosition(allPoints(idx), p, 25, { kinds: ['aerodrome'], limit: 3 }) : []
    return text(`${placeLine(p)}\nNearest aerodromes: ${near.length ? near.map(n => `${n.identifier} ${n.distNm.toFixed(1)} NM`).join(', ') : 'none within 25 NM'}.\n${QUOTE_NOTE}`)
  })

  async function savePlaceAnd(verb: 'created' | 'updated', b: ReturnType<typeof buildPlace>, seenUpdatedAt?: number): Promise<Text> {
    if (verb === 'updated' && b.changed.length === 0) return text('Nothing to change.')
    await c.save.place(b.doc, seenUpdatedAt)
    console.log(`[mcp] place ${verb} user=${caller.userId} client=${caller.clientId} id=${b.doc.id} change=${b.changed.join(',')}`)
    return text(`${verb === 'created' ? 'Saved place' : `Updated place (${b.changed.join(', ')})`}: ${placeLine(b.doc)}\nIt reaches the pilot's devices at the next sync. Use it in a route as PL/${b.doc.name}.\n${QUOTE_NOTE}`)
  }

  c.tool('create_place', {
    description: "Save a new place (name, position, optional folder) for the pilot, e.g. a cabin, a farm strip or a lake they use as a turning point. Position as coordinates (59.35 17.94) or 5921N01756E. Check the position with the pilot when it comes from a description, not coordinates.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: z.object({ name: z.string().min(1).max(60), position: z.string().min(3).max(60), folder: z.string().max(40).optional() }),
  }, async (args) => {
    if (!c.canRoutesWrite) return c.noRoutesWrite()
    if (!c.canRoutes) return c.noRoutes()
    const others = await c.places()
    if ('error' in others) return others.error
    return savePlaceAnd('created', buildPlace(args, { others, newId: crypto.randomUUID(), now: Date.now() }))
  })

  c.tool('update_place', {
    description: "Change one of the pilot's saved places: name, position or folder (only the given fields change; folder \"\" = unfiled). Routes already using the place keep their own copy of the position. Cannot delete a place.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: z.object({ place: z.string().min(1).max(60).describe('Place name or id'), name: z.string().min(1).max(60).optional(), position: z.string().min(3).max(60).optional(), folder: z.string().max(40).optional() }),
  }, async (args) => {
    if (!c.canRoutesWrite) return c.noRoutesWrite()
    if (!c.canRoutes) return c.noRoutes()
    const others = await c.places()
    if ('error' in others) return others.error
    const k = args.place.trim().toLowerCase()
    const existing = others.find(p => p.id === args.place.trim() || p.name.toLowerCase() === k)
    if (!existing) return fail(`No saved place ${quote(args.place, 60)}. Use list_places (the name must match fully).`)
    return savePlaceAnd('updated', buildPlace(args, { existing, others, newId: existing.id, now: Date.now() }), existing.updatedAt)
  })
}
