import { ref } from 'vue'

/**
 * Convenience composable wrapping the `/api/auth/2fa/*` endpoints. State is
 * **per-call** (not module-level): the settings page mounts this once for
 * the enroll dialog and tears it down on close.
 */

interface SetupResponse {
  secret: string
  qrDataUrl: string
  otpauthUrl: string
}

interface EnableResponse {
  backupCodes: string[]
}

interface StatusResponse {
  enabled: boolean
  enrollmentStarted: boolean
  enabledAt: string | Date | null
}

export function useTwoFactor() {
  const status = ref<StatusResponse | null>(null)
  const loading = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function refreshStatus(): Promise<StatusResponse> {
    loading.value = true
    error.value = null
    try {
      const res = await $fetch<StatusResponse>('/api/auth/2fa/status')
      status.value = res
      return res
    }
    catch (e) {
      error.value = (e as Error).message
      throw e
    }
    finally {
      loading.value = false
    }
  }

  async function setup(): Promise<SetupResponse> {
    busy.value = true
    error.value = null
    try {
      return await $fetch<SetupResponse>('/api/auth/2fa/setup', { method: 'POST' })
    }
    catch (e) {
      error.value
        = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
          ?? (e as Error).message
      throw e
    }
    finally {
      busy.value = false
    }
  }

  async function enable(code: string): Promise<EnableResponse> {
    busy.value = true
    error.value = null
    try {
      const res = await $fetch<EnableResponse>('/api/auth/2fa/enable', {
        method: 'POST',
        body: { code },
      })
      await refreshStatus()
      return res
    }
    catch (e) {
      error.value
        = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
          ?? (e as Error).message
      throw e
    }
    finally {
      busy.value = false
    }
  }

  async function disable(password: string): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await $fetch('/api/auth/2fa/disable', {
        method: 'POST',
        body: { password },
      })
      await refreshStatus()
    }
    catch (e) {
      error.value
        = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
          ?? (e as Error).message
      throw e
    }
    finally {
      busy.value = false
    }
  }

  return { status, loading, busy, error, refreshStatus, setup, enable, disable }
}
