import { defineEventHandler, setHeader } from 'h3'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { slugify } from '~/server/utils/export'
import { renderDocDocx } from '~/server/utils/export-docx'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)

  const buf = await renderDocDocx(doc)
  const filename = `${slugify(doc.title || 'untitled')}.docx`

  setHeader(
    event,
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', buf.byteLength)
  return buf
})
