import { describe, expect, it } from 'vitest'
import { chunkMarkdown } from '~/server/utils/chunking'

describe('chunkMarkdown (section-aware)', () => {
  it('returns [] for empty / whitespace-only input', () => {
    expect(chunkMarkdown('', { maxChars: 1500, overlap: 150 })).toEqual([])
    expect(chunkMarkdown('   \n\n  ', { maxChars: 1500, overlap: 150 })).toEqual([])
  })

  it('returns a single chunk for small preamble-only input', () => {
    const md = 'This is a short paragraph that easily fits in one chunk. '.repeat(3)
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toContain('short paragraph')
    expect(chunks[0]!.sectionPath).toEqual([])
  })

  it('preamble (text before any heading) has empty sectionPath []', () => {
    const md = [
      'Some preamble prose that appears before the first heading.',
      '',
      '# First heading',
      '',
      'Body of the first section.',
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]!.sectionPath).toEqual([])
    expect(chunks[0]!.text).toContain('preamble')
    expect(chunks[1]!.sectionPath).toEqual(['First heading'])
  })

  it('splits on H1 boundaries — chunks belonging to different H1 sections have distinct sectionPath', () => {
    const md = [
      '# Alpha',
      '',
      'Body of alpha.',
      '',
      '# Bravo',
      '',
      'Body of bravo.',
      '',
      '# Charlie',
      '',
      'Body of charlie.',
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.sectionPath).toEqual(['Alpha'])
    expect(chunks[1]!.sectionPath).toEqual(['Bravo'])
    expect(chunks[2]!.sectionPath).toEqual(['Charlie'])
  })

  it('sectionPath captures hierarchy — a paragraph under # A / ## B has sectionPath [A, B]', () => {
    const md = [
      '# A',
      '',
      'Alpha-level body.',
      '',
      '## B',
      '',
      'Nested body under A then B.',
      '',
      '### C',
      '',
      'Deepest body.',
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    const byText = (needle: string) => chunks.find(c => c.text.includes(needle))
    expect(byText('Alpha-level body')!.sectionPath).toEqual(['A'])
    expect(byText('Nested body')!.sectionPath).toEqual(['A', 'B'])
    expect(byText('Deepest body')!.sectionPath).toEqual(['A', 'B', 'C'])
  })

  it('skipped heading levels still build a sensible path', () => {
    // H1 -> H3 (no H2): path under H3 is [A, C] (skipped level collapsed).
    const md = [
      '# A',
      '',
      'Body A.',
      '',
      '### C',
      '',
      'Body C.',
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    const cChunk = chunks.find(c => c.text.includes('Body C.'))
    expect(cChunk).toBeDefined()
    expect(cChunk!.sectionPath).toEqual(['A', 'C'])
  })

  it('no overlap across section boundaries — last chunk of section A and first chunk of section B share no leading text', () => {
    const sectionABody = 'Alpha sentence one. '.repeat(150) // ~3000 chars — forces multi-chunk inside A
    const md = [
      '# A',
      '',
      sectionABody,
      '',
      '# B',
      '',
      'Bravo opens fresh with totally distinct words: zephyr, quokka, yacht.',
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    const lastA = [...chunks].reverse().find(c => c.sectionPath[0] === 'A')!
    const firstB = chunks.find(c => c.sectionPath[0] === 'B')!
    expect(lastA).toBeDefined()
    expect(firstB).toBeDefined()
    // The first chars of B must NOT be a tail of A.
    expect(firstB.text.startsWith(lastA.text.slice(-30))).toBe(false)
    expect(firstB.text).toContain('Bravo opens fresh')
    // And the first chunk in B should not contain Alpha-section text.
    expect(firstB.text).not.toContain('Alpha sentence one')
  })

  it('overlap within a single long section — consecutive chunks share trailing text from the previous chunk', () => {
    const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(20) // ~900 chars
    const md = `# Long\n\n${Array.from({ length: 8 }, () => paragraph).join('\n\n')}`
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk should be in the same section.
    for (const c of chunks) expect(c.sectionPath).toEqual(['Long'])
    // At least one consecutive pair shares overlap.
    let foundOverlap = false
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text
      const cur = chunks[i]!.text
      // Look for any ~30-char run from the tail of prev inside cur head.
      const tail = prev.slice(-150)
      const probe = tail.slice(0, 30).trim()
      if (probe.length >= 10 && cur.startsWith(probe.slice(0, Math.min(20, probe.length)))) {
        foundOverlap = true
        break
      }
      // Fall back: check probe appears anywhere in the first 200 chars of cur.
      if (probe.length >= 10 && cur.slice(0, 200).includes(probe.slice(0, 15))) {
        foundOverlap = true
        break
      }
    }
    expect(foundOverlap).toBe(true)
  })

  it('code fences are atomic — a fence containing # fake heading does not create a section split', () => {
    const md = [
      '# Real',
      '',
      'Some prose.',
      '',
      '```bash',
      '# fake heading inside code',
      'echo "still in code"',
      '## also fake',
      '```',
      '',
      'More prose after code.',
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    // Only one section: Real.
    for (const c of chunks) expect(c.sectionPath).toEqual(['Real'])
    // The fence content should appear verbatim somewhere.
    const joined = chunks.map(c => c.text).join('\n')
    expect(joined).toContain('# fake heading inside code')
    expect(joined).toContain('## also fake')
  })

  it('hard cap respected — no chunk exceeds maxChars + overlap tolerance', () => {
    const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    const md = `# Big\n\n${Array.from({ length: 20 }, () => paragraph).join('\n\n')}`
    const maxChars = 1500
    const overlap = 150
    const chunks = chunkMarkdown(md, { maxChars, overlap })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(maxChars + overlap)
    }
  })

  it('handles markdown with only headings (empty sections produce no chunks)', () => {
    const md = ['# Only', '', '## Headings', '', '### Here'].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    expect(chunks).toEqual([])
  })

  it('handles one giant paragraph (no sentence breaks) via hard-window inside its section', () => {
    const md = `# Mono\n\n${'abcdefghij'.repeat(500)}` // 5000-char wall
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.sectionPath).toEqual(['Mono'])
      expect(c.text.length).toBeLessThanOrEqual(1500 + 150)
    }
  })

  it('every chunk carries a sectionPath array (never undefined)', () => {
    const md = [
      'Preamble.',
      '',
      '# A',
      '',
      'Body A '.repeat(50),
      '',
      '## A.1',
      '',
      'Body A.1 '.repeat(50),
    ].join('\n')
    const chunks = chunkMarkdown(md, { maxChars: 1500, overlap: 150 })
    expect(chunks.length).toBeGreaterThan(0)
    for (const c of chunks) {
      expect(Array.isArray(c.sectionPath)).toBe(true)
    }
  })
})
