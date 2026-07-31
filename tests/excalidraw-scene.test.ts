import { describe, expect, it } from 'vitest'
import {
  buildDrawingMarkdown,
  emptyExcalidrawScene,
  extractSceneText,
  isEffectivelyEmptyForAi,
  isExcalidrawScene,
  parseExcalidrawScene,
  serializeExcalidrawScene,
  STRIPPED_IMAGE_PLACEHOLDER,
  stripEmbeddedDataUrls,
  type ExcalidrawElementLike,
} from '~/utils/excalidraw-scene'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

function sceneWith(elements: ExcalidrawElementLike[]) {
  return { ...emptyExcalidrawScene(), elements }
}

describe('parseExcalidrawScene', () => {
  it('round-trips an empty scene', () => {
    const scene = emptyExcalidrawScene()
    const parsed = parseExcalidrawScene(serializeExcalidrawScene(scene))
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('excalidraw')
    expect(parsed!.elements).toEqual([])
  })

  it('returns null for a Tiptap contentJson, not a throw', () => {
    expect(parseExcalidrawScene('{"type":"doc","content":[]}')).toBeNull()
  })

  it('returns null for the default empty column value', () => {
    expect(parseExcalidrawScene('{}')).toBeNull()
    expect(parseExcalidrawScene('')).toBeNull()
    expect(parseExcalidrawScene(null)).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    expect(parseExcalidrawScene('{"elements":[')).toBeNull()
  })

  it('backfills missing optional fields', () => {
    const parsed = parseExcalidrawScene('{"elements":[]}')
    expect(parsed).not.toBeNull()
    expect(parsed!.appState).toEqual({})
    expect(parsed!.files).toEqual({})
    expect(parsed!.source).toBe('noteforge')
  })

  it('recognises a scene by its elements array only', () => {
    expect(isExcalidrawScene({ elements: [] })).toBe(true)
    expect(isExcalidrawScene({ type: 'excalidraw' })).toBe(false)
    expect(isExcalidrawScene(null)).toBe(false)
  })
})

describe('extractSceneText', () => {
  it('reads text elements in reading order, not array order', () => {
    const scene = sceneWith([
      { type: 'text', text: 'bottom', x: 0, y: 300 },
      { type: 'text', text: 'top-right', x: 500, y: 10 },
      { type: 'text', text: 'top-left', x: 10, y: 12 },
    ])
    expect(extractSceneText(scene)).toEqual(['top-left', 'top-right', 'bottom'])
  })

  it('picks up text bound to a shape', () => {
    const scene = sceneWith([
      { type: 'rectangle', x: 0, y: 0 },
      { type: 'text', text: 'inside the box', containerId: 'abc', x: 5, y: 5 },
    ])
    expect(extractSceneText(scene)).toEqual(['inside the box'])
  })

  it('picks up frame names', () => {
    const scene = sceneWith([{ type: 'frame', name: 'Sprint 4', x: 0, y: 0 }])
    expect(extractSceneText(scene)).toEqual(['Sprint 4'])
  })

  it('skips tombstoned elements', () => {
    const scene = sceneWith([
      { type: 'text', text: 'kept', x: 0, y: 0 },
      { type: 'text', text: 'removed', isDeleted: true, x: 0, y: 50 },
    ])
    expect(extractSceneText(scene)).toEqual(['kept'])
  })

  it('skips blank and whitespace-only labels', () => {
    const scene = sceneWith([
      { type: 'text', text: '   ', x: 0, y: 0 },
      { type: 'text', text: 'real', x: 0, y: 50 },
    ])
    expect(extractSceneText(scene)).toEqual(['real'])
  })

  it('returns nothing for a null scene', () => {
    expect(extractSceneText(null)).toEqual([])
  })
})

describe('buildDrawingMarkdown', () => {
  it('puts text before the image so search snippets stay readable', () => {
    const md = buildDrawingMarkdown({
      scene: sceneWith([{ type: 'text', text: 'Architecture', x: 0, y: 0 }]),
      preview: PNG,
      title: 'Schéma',
    })
    expect(md.indexOf('Architecture')).toBeLessThan(md.indexOf('data:image'))
    expect(md).toContain(`![Schéma](${PNG})`)
  })

  it('emits only the image when the drawing has no text', () => {
    const md = buildDrawingMarkdown({ scene: emptyExcalidrawScene(), preview: PNG, title: 'X' })
    expect(md).toBe(`![X](${PNG})`)
  })

  it('emits only the text when there is no preview (headless writer)', () => {
    const md = buildDrawingMarkdown({
      scene: sceneWith([{ type: 'text', text: 'note', x: 0, y: 0 }]),
      title: 'X',
    })
    expect(md).toBe('note')
  })

  it('falls back to a default alt text', () => {
    const md = buildDrawingMarkdown({ scene: emptyExcalidrawScene(), preview: PNG })
    expect(md).toBe(`![Excalidraw](${PNG})`)
  })

  it('strips brackets from the alt text so the image link cannot break', () => {
    const md = buildDrawingMarkdown({ scene: emptyExcalidrawScene(), preview: PNG, title: 'a [b] c' })
    expect(md).toBe(`![a b c](${PNG})`)
  })

  it('produces an empty body for an empty scene with no preview', () => {
    expect(buildDrawingMarkdown({ scene: emptyExcalidrawScene() })).toBe('')
  })
})

describe('stripEmbeddedDataUrls', () => {
  it('is a no-op on ordinary markdown', () => {
    const md = '# Title\n\nSome ![real](/uploads/a.png) content.'
    expect(stripEmbeddedDataUrls(md)).toBe(md)
  })

  it('replaces a data-URL image with its alt text', () => {
    expect(stripEmbeddedDataUrls(`before\n\n![Schéma](${PNG})\n\nafter`))
      .toBe('before\n\n[Schéma]\n\nafter')
  })

  it('replaces an alt-less data-URL image with a placeholder', () => {
    expect(stripEmbeddedDataUrls(`![](${PNG})`)).toBe(STRIPPED_IMAGE_PLACEHOLDER)
  })

  it('strips an inline img tag', () => {
    expect(stripEmbeddedDataUrls(`x <img src="${PNG}" width="10"> y`))
      .toBe(`x ${STRIPPED_IMAGE_PLACEHOLDER} y`)
  })

  it('empties the payload of a legacy whiteboard block but keeps the element', () => {
    const md = `<div class="whiteboard" data-scene="AAAA" data-w="800" data-preview="${PNG}"></div>`
    const out = stripEmbeddedDataUrls(md)
    expect(out).toContain('class="whiteboard"')
    expect(out).toContain('data-w="800"')
    expect(out).not.toContain('iVBORw0KGgo')
    expect(out).not.toContain('AAAA')
  })

  it('keeps a regular markdown image untouched while stripping the data one', () => {
    const md = `![keep](/x.png)\n\n![drop](${PNG})`
    expect(stripEmbeddedDataUrls(md)).toBe('![keep](/x.png)\n\n[drop]')
  })

  it('leaves the body unchanged when no data URL is present (fast path)', () => {
    const md = 'nothing to do here'
    expect(stripEmbeddedDataUrls(md)).toBe(md)
  })
})

describe('isEffectivelyEmptyForAi', () => {
  it('is true for an image-only drawing', () => {
    expect(isEffectivelyEmptyForAi(`![Schéma sans texte](${PNG})`)).toBe(false)
    expect(isEffectivelyEmptyForAi(`![](${PNG})`)).toBe(true)
  })

  it('is false as soon as the drawing carries text', () => {
    expect(isEffectivelyEmptyForAi(`Architecture\n\n![](${PNG})`)).toBe(false)
  })

  it('is true for an empty body', () => {
    expect(isEffectivelyEmptyForAi('')).toBe(true)
    expect(isEffectivelyEmptyForAi('   \n\n ')).toBe(true)
  })
})
