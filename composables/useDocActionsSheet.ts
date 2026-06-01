import { ref } from 'vue'

/**
 * Mobile action sheet for the document header. Module-scoped so the layout's
 * topbar button and the doc page (which renders the sheet) share one state —
 * same pattern as useMobileSidebar / useDocInsightsSheet.
 *
 * On mobile the in-page `.doc-header` (crumbs + edited time + favorite +
 * Ask/Share/Export/History/Delete chips) is hidden to reclaim vertical space;
 * its contents live in this sheet instead.
 */
const isOpen = ref(false)

export function useDocActionsSheet() {
  function open(): void { isOpen.value = true }
  function close(): void { isOpen.value = false }
  function toggle(): void { isOpen.value = !isOpen.value }
  return { isOpen, open, close, toggle }
}
