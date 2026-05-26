import { defineEventHandler, setHeader } from 'h3'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { slugify } from '~/server/utils/export'
import { renderDocPdf } from '~/server/utils/export-pdf'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)

  const buf = await renderDocPdf(doc)
  const filename = `${slugify(doc.title || 'untitled')}.pdf`

  setHeader(event, 'Content-Type', 'application/pdf')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', buf.byteLength)
  return buf
})
