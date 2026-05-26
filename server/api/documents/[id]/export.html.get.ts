import { defineEventHandler, setHeader } from 'h3'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { buildHtml, slugify } from '~/server/utils/export'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)

  const body = buildHtml(doc)
  const filename = `${slugify(doc.title || 'untitled')}.html`

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  return body
})
