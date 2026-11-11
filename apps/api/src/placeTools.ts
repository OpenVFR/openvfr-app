/**
 * Saved places written by the pilot's AI assistant (create_place /
 * update_place): input checking and the resulting place document, without
 * I/O. A place is a name and a position with an optional folder; routes use
 * it as PL/<name>, so names must be unique (ignoring case) and plain.
 */
import type { UserWaypointDocType } from '@open-vfr/shared/types'
import { parseCoordinate } from '@open-vfr/shared/coordinateParse'

export const MAX_PLACES = 500
const NAME_MAX = 60
const FOLDER_MAX = 40

export class PlaceInputError extends Error {}

export interface PlaceInput {
  name?: string
  /** Any form the app's search accepts: "59.35 17.94", "5939N01756E", degrees-minutes... */
  position?: string
  folder?: string
}

export interface PlaceBuild { doc: UserWaypointDocType; changed: string[] }

// Letters, digits, spaces and common punctuation; no slash (PL/<name> is a path) and no control characters.
const plain = /^[\p{L}\p{N}][\p{L}\p{N} .,'()+&-]*$/u

export function buildPlace(
  input: PlaceInput,
  ctx: { existing?: UserWaypointDocType; others: readonly UserWaypointDocType[]; newId: string; now: number },
): PlaceBuild {
  const { existing } = ctx
  const changed: string[] = []
  let { name, lat, lng, folder } = existing ?? { name: '', lat: 0, lng: 0, folder: '' }

  if (input.name !== undefined) {
    const n = input.name.trim().replace(/\s+/g, ' ')
    if (!n || n.length > NAME_MAX || !plain.test(n)) throw new PlaceInputError(`Name: 1-${NAME_MAX} letters, digits, spaces and . , ' ( ) + & - (no slash).`)
    if (ctx.others.some(o => o.id !== existing?.id && o.name.trim().toLowerCase() === n.toLowerCase())) throw new PlaceInputError(`A place named "${n}" exists. Use update_place to change it, or choose another name.`)
    if (n !== name) { name = n; changed.push('name') }
  } else if (!existing) {
    throw new PlaceInputError('A place needs a name.')
  }

  if (input.position !== undefined) {
    const c = parseCoordinate(input.position)
    if (!c || Math.abs(c.lat) > 90 || Math.abs(c.lng) > 180) throw new PlaceInputError(`Position "${input.position.slice(0, 40)}" is not a coordinate. Use e.g. 59.3500 17.9400 or 5921N01756E.`)
    const lat5 = Math.round(c.lat * 1e5) / 1e5, lng5 = Math.round(c.lng * 1e5) / 1e5
    if (lat5 !== lat || lng5 !== lng) { lat = lat5; lng = lng5; changed.push('position') }
  } else if (!existing) {
    throw new PlaceInputError('A place needs a position.')
  }

  if (input.folder !== undefined) {
    const f = input.folder.trim()
    if (f.length > FOLDER_MAX || (f && !plain.test(f))) throw new PlaceInputError(`Folder: at most ${FOLDER_MAX} letters, digits, spaces and . , ' ( ) + & - (empty = unfiled).`)
    if (f !== folder) { folder = f; changed.push('folder') }
  }

  if (!existing && ctx.others.length >= MAX_PLACES) throw new PlaceInputError(`At most ${MAX_PLACES} saved places.`)
  return { doc: { id: existing?.id ?? ctx.newId, name, lat, lng, folder, updatedAt: ctx.now }, changed: existing ? changed : ['created'] }
}
