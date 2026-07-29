import { describe, expect, it } from 'vitest'
import { applyUnifiedPatch, parseUnifiedPatch, PatchParseError } from '~/server/utils/patch'

const DOC = [
  '# Project',
  '',
  '## Roadmap',
  '',
  '- ship the beta in June',
  '- write the docs',
  '',
  '## Notes',
  '',
  'Nothing yet.',
].join('\n')

function ok(result: ReturnType<typeof applyUnifiedPatch>) {
  if (!result.ok) throw new Error(`expected success, got: ${result.failure.reason}`)
  return result
}

describe('parseUnifiedPatch', () => {
  it('parses hunk headers with and without line counts', () => {
    const { hunks } = parseUnifiedPatch(
      '@@ -3,2 +3,2 @@\n-a\n+b\n@@ @@\n-c\n+d\n',
    )
    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.oldStart).toBe(3)
    expect(hunks[1]?.oldStart).toBeNull()
  })

  it('ignores git file headers and the no-newline marker', () => {
    const { hunks } = parseUnifiedPatch(
      'diff --git a/note.md b/note.md\nindex 1234567..89abcde 100644\n--- a/note.md\n+++ b/note.md\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n',
    )
    expect(hunks).toHaveLength(1)
    expect(hunks[0]?.before).toEqual(['a'])
    expect(hunks[0]?.after).toEqual(['b'])
  })

  it('unwraps a fenced patch', () => {
    const { hunks } = parseUnifiedPatch('```diff\n@@ -1 +1 @@\n-a\n+b\n```')
    expect(hunks[0]?.after).toEqual(['b'])
  })

  it('treats an unprefixed line as context and warns', () => {
    const { hunks, warnings } = parseUnifiedPatch('@@ @@\ncontext\n-a\n+b\n')
    expect(hunks[0]?.before).toEqual(['context', 'a'])
    expect(hunks[0]?.after).toEqual(['context', 'b'])
    expect(warnings).toHaveLength(1)
  })

  it('rejects a patch with no hunk', () => {
    expect(() => parseUnifiedPatch('just some prose')).toThrow(PatchParseError)
  })

  it('rejects a patch that changes nothing', () => {
    expect(() => parseUnifiedPatch('@@ -1,2 +1,2 @@\n a\n b\n')).toThrow(PatchParseError)
  })
})

describe('applyUnifiedPatch', () => {
  it('replaces a line inside the document', () => {
    const result = ok(applyUnifiedPatch(DOC, [
      '@@ -3,4 +3,5 @@',
      ' ## Roadmap',
      ' ',
      '-- ship the beta in June',
      '+- ship the beta in July',
      '+- write the migration guide',
      ' - write the docs',
    ].join('\n')))

    expect(result.markdown).toContain('- ship the beta in July')
    expect(result.markdown).toContain('- write the migration guide')
    expect(result.markdown).not.toContain('June')
    // Untouched sections survive verbatim.
    expect(result.markdown).toContain('## Notes')
    expect(result.hunks[0]).toMatchObject({ match: 'exact', fuzz: 0, removed: 1, added: 2 })
  })

  it('locates a hunk by content when the line numbers are wrong', () => {
    const result = ok(applyUnifiedPatch(DOC, [
      '@@ -900,2 +900,2 @@',
      '-Nothing yet.',
      '+Something now.',
    ].join('\n')))

    expect(result.markdown).toContain('Something now.')
    expect(result.hunks[0]?.appliedAtLine).toBe(10)
    expect(result.hunks[0]?.lineDrift).not.toBe(0)
  })

  it('applies several hunks in order', () => {
    const result = ok(applyUnifiedPatch(DOC, [
      '@@ -1 +1 @@',
      '-# Project',
      '+# Project X',
      '@@ -10 +10 @@',
      '-Nothing yet.',
      '+All good.',
    ].join('\n')))

    expect(result.markdown.split('\n')[0]).toBe('# Project X')
    expect(result.markdown).toContain('All good.')
    expect(result.hunks).toHaveLength(2)
  })

  it('keeps later hunks anchored after earlier ones', () => {
    const doc = ['x', 'dup', 'y', 'dup', 'z'].join('\n')
    const result = ok(applyUnifiedPatch(doc, [
      '@@ -2 +2 @@',
      '-dup',
      '+first',
      '@@ -4 +4 @@',
      '-dup',
      '+second',
    ].join('\n')))

    expect(result.markdown.split('\n')).toEqual(['x', 'first', 'y', 'second', 'z'])
  })

  it('falls back to whitespace-insensitive matching', () => {
    const result = ok(applyUnifiedPatch(DOC, [
      '@@ @@',
      '-  - write the docs   ',
      '+- write the docs and the changelog',
    ].join('\n')))

    expect(result.markdown).toContain('- write the docs and the changelog')
    expect(result.hunks[0]?.match).toBe('whitespace')
  })

  it('trims stale context (fuzz) to land the change', () => {
    const result = ok(applyUnifiedPatch(DOC, [
      '@@ @@',
      ' ## Roadmap (2026)',
      ' ',
      '-- write the docs',
      '+- write the docs and the changelog',
      ' ',
      ' ## Notes (stale)',
    ].join('\n')))

    expect(result.markdown).toContain('- write the docs and the changelog')
    expect(result.hunks[0]?.fuzz).toBeGreaterThan(0)
  })

  it('inserts a context-less hunk at the declared line', () => {
    const result = ok(applyUnifiedPatch(DOC, '@@ -2,0 +2,1 @@\n+> draft\n'))
    expect(result.markdown.split('\n')[1]).toBe('> draft')
  })

  it('refuses a context-less insertion with no line number', () => {
    const result = applyUnifiedPatch(DOC, '@@ @@\n+> draft\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.reason).toMatch(/no context lines/)
  })

  it('reports an already-applied patch as such', () => {
    const result = applyUnifiedPatch(DOC, '@@ @@\n-Nothing here.\n+Nothing yet.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.reason).toMatch(/already applied/)
  })

  it('returns the real document window when a hunk misses', () => {
    const result = applyUnifiedPatch(DOC, '@@ -5 +5 @@\n-- ship the alpha in June\n+- ship the alpha in July\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.expected).toEqual(['- ship the alpha in June'])
    expect(result.failure.actual.lines).toContain('- ship the beta in June')
  })

  it('leaves the document untouched when a later hunk fails', () => {
    const result = applyUnifiedPatch(DOC, [
      '@@ @@',
      '-# Project',
      '+# Project X',
      '@@ @@',
      '-this line does not exist',
      '+neither does this',
    ].join('\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.index).toBe(2)
  })

  it('handles CRLF in both the document and the patch', () => {
    const result = ok(applyUnifiedPatch(
      'alpha\r\nbeta\r\n',
      '@@ -2 +2 @@\r\n-beta\r\n+gamma\r\n',
    ))
    expect(result.markdown).toBe('alpha\ngamma\n')
  })

  it('preserves a blank context line whose leading space was dropped', () => {
    const result = ok(applyUnifiedPatch(DOC, [
      '@@ -7,3 +7,3 @@',
      '',
      '-## Notes',
      '+## Remarks',
      '',
    ].join('\n')))

    expect(result.markdown).toContain('## Remarks')
    expect(result.markdown).not.toContain('## Notes')
  })
})
