import { ref } from 'vue'
import { useTreeStore } from '~/stores/tree'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'

const MD_EXTS = ['.md', '.markdown', '.txt']
const OCR_MIMES = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
  'image/gif',
])
const OCR_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']

const MAX_FILES = 50
const MAX_OCR_FILES = 20
const MAX_OCR_BYTES_PER_FILE = 50 * 1024 * 1024 // 50 MB

interface MarkdownResponse {
  documents: { id: number, title: string, folderId: number | null }[]
  folders: { id: number, name: string, parentId: number | null }[]
}

interface OcrResponse {
  documents: { id: number, title: string, folderId: number | null }[]
  skipped: { name: string, reason: string }[]
}

type Bucket = 'markdown' | 'ocr' | 'unsupported'

function bucketFor(file: File): Bucket {
  const lower = file.name.toLowerCase()
  if (MD_EXTS.some(ext => lower.endsWith(ext))) return 'markdown'
  const mime = (file.type || '').toLowerCase()
  if (OCR_MIMES.has(mime)) return 'ocr'
  if (OCR_EXTS.some(ext => lower.endsWith(ext))) return 'ocr'
  return 'unsupported'
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '')
    fr.onerror = () => reject(fr.error ?? new Error('Failed to read file'))
    fr.readAsText(file)
  })
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const result = fr.result
      if (typeof result !== 'string') {
        reject(new Error('Unexpected reader result'))
        return
      }
      // result is a data URL like "data:application/pdf;base64,XXXX". Strip prefix.
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    fr.onerror = () => reject(fr.error ?? new Error('Failed to read file'))
    fr.readAsDataURL(file)
  })
}

function mimeFromFile(file: File): string {
  if (file.type) return file.type
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

export function useFileImport() {
  const treeStore = useTreeStore()
  const dialog = useDialog()
  const { t } = useLocale()

  const busy = ref(false)

  async function importFiles(
    files: File[],
    opts: { workspaceId: number, parentFolderId: number | null },
  ): Promise<void> {
    if (files.length === 0) return
    if (files.length > MAX_FILES) {
      await dialog.alert({
        title: t('import.tooManyTitle'),
        message: t('import.tooManyMsg', { max: MAX_FILES, n: files.length }),
      })
      return
    }

    const mdFiles: File[] = []
    const ocrFiles: File[] = []
    const skipped: string[] = []
    for (const f of files) {
      const b = bucketFor(f)
      if (b === 'markdown') mdFiles.push(f)
      else if (b === 'ocr') ocrFiles.push(f)
      else skipped.push(f.name)
    }

    if (mdFiles.length === 0 && ocrFiles.length === 0) {
      await dialog.alert({
        title: t('import.unsupportedTitle'),
        message: t('import.unsupportedMsg'),
      })
      return
    }

    if (ocrFiles.length > MAX_OCR_FILES) {
      await dialog.alert({
        title: t('import.tooManyTitle'),
        message: t('import.tooManyOcrMsg', { max: MAX_OCR_FILES, n: ocrFiles.length }),
      })
      return
    }
    for (const f of ocrFiles) {
      if (f.size > MAX_OCR_BYTES_PER_FILE) {
        await dialog.alert({
          title: t('import.tooLargeTitle'),
          message: t('import.tooLargeOcrMsg', {
            name: f.name,
            mb: Math.round(MAX_OCR_BYTES_PER_FILE / (1024 * 1024)),
          }),
        })
        return
      }
    }

    busy.value = true
    let createdDocs = 0
    let createdFolders = 0
    const failures: { name: string, reason: string }[] = []

    try {
      if (mdFiles.length > 0) {
        const entries: { path: string, content: string }[] = []
        for (const f of mdFiles) {
          const content = await readAsText(f)
          entries.push({ path: f.name, content })
        }
        const res = await $fetch<MarkdownResponse>('/api/import/markdown', {
          method: 'POST',
          body: {
            workspaceId: opts.workspaceId,
            parentFolderId: opts.parentFolderId,
            files: entries,
          },
        })
        createdDocs += res.documents.length
        createdFolders += res.folders.length
      }

      if (ocrFiles.length > 0) {
        const entries: { name: string, mime: string, contentBase64: string }[] = []
        for (const f of ocrFiles) {
          const b64 = await readAsBase64(f)
          entries.push({ name: f.name, mime: mimeFromFile(f), contentBase64: b64 })
        }
        const res = await $fetch<OcrResponse>('/api/import/ocr', {
          method: 'POST',
          body: {
            workspaceId: opts.workspaceId,
            parentFolderId: opts.parentFolderId,
            files: entries,
          },
        })
        createdDocs += res.documents.length
        for (const s of res.skipped) failures.push(s)
      }

      await treeStore.fetchWorkspaceTree(opts.workspaceId, true)

      const docsPart = createdDocs === 0
        ? t('import.completeNoDocs')
        : createdDocs === 1
          ? t('import.completeOneDoc')
          : t('import.completeDocs', { n: createdDocs })
      const foldersPart = createdFolders === 0
        ? t('import.completePeriod')
        : createdFolders === 1
          ? t('import.completeOneFolder')
          : t('import.completeFolders', { n: createdFolders })
      let message = `${docsPart}${foldersPart}`
      if (skipped.length > 0) {
        message += `\n\n${t('import.skippedUnsupported', { names: skipped.join(', ') })}`
      }
      if (failures.length > 0) {
        const lines = failures.map(f => `• ${f.name} — ${f.reason}`).join('\n')
        message += `\n\n${t('import.failedFiles')}\n${lines}`
      }
      await dialog.alert({
        title: t('import.completeTitle'),
        message,
      })
    }
    catch (err) {
      const msg = err instanceof Error
        ? err.message
        : (err as { statusMessage?: string })?.statusMessage ?? 'Unknown error'
      await dialog.alert({
        title: t('import.failedTitle'),
        message: msg,
      })
    }
    finally {
      busy.value = false
    }
  }

  return { busy, importFiles }
}
