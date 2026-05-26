import { defineEventHandler, setHeader } from 'h3'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { buildMarkdown, slugify } from '~/server/utils/export'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)

  const body = buildMarkdown(doc)
  const filename = `${slugify(doc.title || 'untitled')}.md`

  setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  return body
})
