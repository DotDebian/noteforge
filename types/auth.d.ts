declare module '#auth-utils' {
  interface User {
    id: number
    email: string
    displayName?: string | null
    isAdmin?: boolean
  }
  interface UserSession {
    user: User
    loggedInAt: number
    /**
     * Base64 of the user's Data Encryption Key, unwrapped at login and
     * kept in the encrypted session cookie. Optional because legacy
     * sessions minted before the encryption rollout don't carry it (and
     * MCP requests have no session at all). See `server/utils/dek.ts`.
     */
    dek?: string
    /**
     * When an admin impersonates another user via
     * `POST /api/admin/users/:id/impersonate`, the original admin's id is
     * parked here so the front can show an "Exit impersonation" banner and
     * `/api/admin/users/:id/stop-impersonate` can restore the admin's
     * session. Absent on regular sessions.
     */
    originalAdminId?: number
    impersonating?: boolean
  }
}

export {}
