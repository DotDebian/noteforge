import { ref } from 'vue'

interface ResizableOptions {
  /** Drag axis: 'x' for left/right panels, 'y' for top/bottom docks. */
  axis: 'x' | 'y'
  /** Read the current size (px) at drag start. */
  get: () => number
  /** Commit a new size (px). Clamping + persistence are the caller's job. */
  set: (px: number) => void
  /**
   * Invert the delta. A panel whose handle sits on the edge *facing* the
   * pointer's "grow" direction needs this: e.g. a right-anchored rail with a
   * handle on its LEFT edge grows when the pointer moves left (decreasing
   * clientX), and the bottom dock grows when the pointer moves up (decreasing
   * clientY). Set `invert: true` in those cases.
   */
  invert?: boolean
}

/**
 * Pointer-driven drag-to-resize for docked side panels. Shared by the chat
 * dock (vertical) and the document rail (horizontal). While dragging it pins
 * the body cursor and suppresses text selection so the gesture stays smooth
 * even when the pointer outruns layout.
 */
export function useResizable(opts: ResizableOptions) {
  const resizing = ref(false)
  let startPos = 0
  let startSize = 0

  function onMove(e: PointerEvent) {
    if (!resizing.value) return
    const pos = opts.axis === 'x' ? e.clientX : e.clientY
    const delta = (pos - startPos) * (opts.invert ? -1 : 1)
    opts.set(startSize + delta)
  }

  function end() {
    if (!resizing.value) return
    resizing.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', end)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }

  function start(e: PointerEvent) {
    e.preventDefault()
    resizing.value = true
    startPos = opts.axis === 'x' ? e.clientX : e.clientY
    startSize = opts.get()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = opts.axis === 'x' ? 'ew-resize' : 'ns-resize'
  }

  return { resizing, start, end }
}
