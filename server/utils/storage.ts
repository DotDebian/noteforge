import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Attachment } from '~/server/database/schema'

/**
 * On-disk root for user uploads. Lives under `data/` which is gitignored.
 * Files are content-addressed: `<workspaceId>/<sha256[0:2]>/<sha256>.<ext>`.
 * The two-char prefix directory keeps any single dir from ballooning past
 * filesystem limits and gives us a cheap O(1) shard.
 */
export const UPLOADS_ROOT = path.join(process.cwd(), 'data', 'uploads')

/**
 * Map a MIME type to a safe file extension. The allowlist mirrors the
 * upload endpoint's accepted MIME set. Unknown MIMEs fall back to `bin`
 * (which is fine for round-tripping — the MIME stored in the DB is what
 * we actually serve back with `Content-Type`).
 */
export function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

/**
 * Returns true if the file at `p` already exists (used to short-circuit
 * writes when the same content is uploaded twice — content-addressed
 * dedup).
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  }
  catch {
    return false
  }
}

export interface SaveAttachmentInput {
  workspaceId: number
  buffer: Buffer
  mime: string
  filename: string
}

export interface SaveAttachmentResult {
  sha256: string
  byteSize: number
  /** Path relative to UPLOADS_ROOT — useful for logging/debug, not used by clients. */
  relPath: string
}

/**
 * Hash the buffer, derive a content-addressed path, mkdir -p, and write
 * the file if it doesn't already exist. Idempotent: identical content
 * uploaded twice produces a single on-disk file.
 *
 * The on-disk filename is derived ENTIRELY from sha256 + the
 * allowlist-mapped extension; the user-provided `filename` is never used
 * as part of the path. That stays in the DB only.
 */
export async function saveAttachment(input: SaveAttachmentInput): Promise<SaveAttachmentResult> {
  const sha256 = createHash('sha256').update(input.buffer).digest('hex')
  const ext = mimeToExt(input.mime)
  const shard = sha256.slice(0, 2)
  const relPath = path.join(String(input.workspaceId), shard, `${sha256}.${ext}`)
  const absPath = path.join(UPLOADS_ROOT, relPath)
  const absDir = path.dirname(absPath)

  await mkdir(absDir, { recursive: true })
  if (!(await fileExists(absPath))) {
    await writeFile(absPath, input.buffer)
  }

  return {
    sha256,
    byteSize: input.buffer.byteLength,
    relPath,
  }
}

/**
 * Reverse of `saveAttachment`: reconstruct the path from the DB row and
 * read the bytes back. Callers MUST have run `assertWorkspaceAccess`
 * against `rec.workspaceId` before calling this.
 */
export async function readAttachment(rec: Attachment): Promise<Buffer> {
  const ext = mimeToExt(rec.mime)
  const shard = rec.sha256.slice(0, 2)
  const absPath = path.join(
    UPLOADS_ROOT,
    String(rec.workspaceId),
    shard,
    `${rec.sha256}.${ext}`,
  )
  return readFile(absPath)
}
