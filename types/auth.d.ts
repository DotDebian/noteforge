declare module '#auth-utils' {
  interface User {
    id: number
    email: string
    displayName?: string | null
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
  }
}

export {}
