/**
 * Midpoint-based position computation for sidebar reorder DnD.
 *
 * Siblings are stored in `position` integer columns; gaps of ~1024 are
 * preserved so we can insert between two neighbors without renumbering.
 * When the gap runs out (midpoint collides with a neighbor), the tree
 * store falls back to a full renumber for that scope.
 *
 * `siblings` MUST be sorted ascending by position.
 *
 *   insertBeforeId === null  ⇒ append at tail
 *   siblings.length === 0    ⇒ empty list, use 0
 */

const GAP = 1024

export interface Positioned {
  id: number
  position: number
}

/**
 * @param siblings  All siblings in the target scope, sorted by position,
 *                  INCLUDING the dragged item (filtered out internally).
 * @param draggedId The id of the item being dragged. Excluded so it doesn't
 *                  count as its own neighbor.
 * @param insertBeforeId  The id of the row the dragged item should land
 *                        ABOVE, or null to mean "drop at the tail".
 */
export function computeReorderPosition(
  siblings: Positioned[],
  draggedId: number,
  insertBeforeId: number | null,
): number {
  const list = siblings.filter(s => s.id !== draggedId)
  if (list.length === 0) return GAP

  if (insertBeforeId === null) {
    // Append at end.
    const last = list[list.length - 1]!
    return last.position + GAP
  }

  const idx = list.findIndex(s => s.id === insertBeforeId)
  if (idx === -1) {
    // Defensive: target vanished — treat as append.
    const last = list[list.length - 1]!
    return last.position + GAP
  }
  if (idx === 0) {
    // Prepend.
    const first = list[0]!
    return first.position - GAP
  }
  const prev = list[idx - 1]!
  const next = list[idx]!
  // Midpoint. If neighbors are adjacent integers, this rounds — collision
  // is detected by the tree store which then renumbers.
  return Math.floor((prev.position + next.position) / 2)
}
