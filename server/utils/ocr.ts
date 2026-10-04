/**
 * Document → markdown transcription for the import flow, done by Claude: the
 * file travels as an attachment (PDF document block, or image) on a single
 * request, and the reply is the transcription.
 */
import { claudeChat, CLAUDE_IMAGE_MIMES, type ChatContentPart, type ClaudeImageMime } from './claude'

/**
 * Size ceilings, on the raw file. The API caps a request at 32 MB and an
 * image at 5 MB, both measured after base64 inflates the bytes by 4/3.
 */
export const OCR_MAX_PDF_BYTES = 22 * 1024 * 1024
export const OCR_MAX_IMAGE_BYTES = 3.5 * 1024 * 1024

/** Room for roughly 100 dense pages of transcription. */
const OCR_MAX_OUTPUT_TOKENS = 64_000

export const OCR_NO_TEXT = '*(no text extracted)*'

const OCR_SYSTEM_PROMPT = `You transcribe documents into Markdown for a notes app. The attached file is a scanned or digital document (a PDF or an image). Your transcription becomes a note the user will search and edit, so it should carry everything the document says and nothing it doesn't.

- Reproduce the full text faithfully, in reading order, page after page. Transcribe; don't summarise, translate, correct or comment.
- Use Markdown structure where the document has it: headings, lists, and Markdown tables for tabular data.
- If the document has a title, put it first as a level-1 heading: it becomes the note's title.
- Where a figure, chart or photo carries information the text doesn't, describe it in one italic line; skip purely decorative images.
- Mark a passage you can't read as [illisible] rather than guessing.

Your reply is saved as the note verbatim, so output only the Markdown: no preamble, no code fence around it. If the document contains no readable text, reply with exactly: ${OCR_NO_TEXT}`

/** Mime as Claude names it, or null for a format it can't read (e.g. AVIF). */
function claudeImageMime(mime: string): ClaudeImageMime | null {
  const normalised = mime === 'image/jpg' ? 'image/jpeg' : mime
  return CLAUDE_IMAGE_MIMES.find(m => m === normalised) ?? null
}

/**
 * Transcribe a PDF or image to markdown. Throws with a user-readable message
 * when the file can't be sent (unsupported format, too large) or the call
 * fails; the import endpoint reports that as the file's skip reason.
 */
export async function ocrToMarkdown(
  bytes: Buffer,
  mime: string,
  opts?: { userId?: number },
): Promise<string> {
  let attachment: ChatContentPart
  if (mime === 'application/pdf') {
    if (bytes.length > OCR_MAX_PDF_BYTES) {
      throw new Error(`PDF too large for OCR (max ${Math.round(OCR_MAX_PDF_BYTES / (1024 * 1024))} MB)`)
    }
    attachment = { type: 'pdf', data: bytes.toString('base64') }
  }
  else {
    const mediaType = claudeImageMime(mime)
    if (!mediaType) throw new Error(`Image format not supported for OCR: ${mime}`)
    if (bytes.length > OCR_MAX_IMAGE_BYTES) {
      throw new Error(`Image too large for OCR (max ${OCR_MAX_IMAGE_BYTES / (1024 * 1024)} MB)`)
    }
    attachment = { type: 'image', mediaType, data: bytes.toString('base64') }
  }

  const { content, truncated } = await claudeChat({
    messages: [
      { role: 'system', content: OCR_SYSTEM_PROMPT },
      { role: 'user', content: [attachment, { type: 'text', text: 'Transcribe this document.' }] },
    ],
    maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
    userId: opts?.userId,
    operation: 'ocr',
  })
  const markdown = content.trim()
  // Say so in the note rather than let a cut-off transcription pass for complete.
  return truncated
    ? `${markdown}\n\n*(transcription truncated: the document is too long to transcribe in one pass)*`
    : markdown
}
