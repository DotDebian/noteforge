/**
 * Public-facing user shape returned by /api/auth endpoints.
 * Mirrors the schema `User` but without the password hash. We keep this
 * locally typed so the UI can rely on the shape regardless of how
 * auth-utils' module augmentation evolves (owned by Agent A).
 */
export interface PublicUser {
  id: number
  email: string
  displayName?: string | null
  createdAt?: string | number | Date
}

interface AuthLoginBody {
  email: string
  password: string
}

interface AuthRegisterBody extends AuthLoginBody {
  displayName?: string
  inviteCode: string
}

interface LoginResponse {
  user: PublicUser
  /** Surfaced only when a legacy account just had its data encrypted on
   *  this login — the UI must show it ONCE and then drop it from memory. */
  recoveryKey?: string
}

interface RegisterResponse {
  user: PublicUser
  workspaceId?: number
  /** Clear recovery key, shown ONCE at registration. */
  recoveryKey: string
}

/**
 * Thin wrapper around `useUserSession()` (nuxt-auth-utils) that exposes
 * typed login/register/logout helpers. The session itself is the source
 * of truth; these helpers just trigger the server endpoints and refresh.
 */
export function useAuth() {
  const session = useUserSession()

  async function login(body: AuthLoginBody): Promise<LoginResponse> {
    const res = await $fetch<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body,
    })
    await session.fetch()
    return res
  }

  async function register(body: AuthRegisterBody): Promise<RegisterResponse> {
    const res = await $fetch<RegisterResponse>('/api/auth/register', {
      method: 'POST',
      body,
    })
    await session.fetch()
    return res
  }

  async function logout(): Promise<void> {
    await $fetch('/api/auth/logout', { method: 'POST' })
    await session.clear()
  }

  interface RecoverBody { email: string, recoveryKey: string, newPassword: string }
  interface RecoverResponse { user: PublicUser, recoveryKey: string }
  async function recover(body: RecoverBody): Promise<RecoverResponse> {
    const res = await $fetch<RecoverResponse>('/api/auth/recover', {
      method: 'POST',
      body,
    })
    await session.fetch()
    return res
  }

  return {
    user: session.user,
    loggedIn: session.loggedIn,
    session,
    login,
    register,
    logout,
    recover,
  }
}
