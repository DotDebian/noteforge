import bcrypt from 'bcryptjs'
import type { User } from '~/server/database/schema'

const BCRYPT_COST = 10

// Named `bcryptHash*` to avoid clashing with nuxt-auth-utils'
// auto-imported scrypt-based `hashPassword`/`verifyPassword`.
export async function bcryptHashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST)
}

export async function bcryptVerifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export function serializeUser(
  user: Pick<User, 'id' | 'email'> & Partial<Pick<User, 'displayName'>>,
): { id: number, email: string, displayName: string | null } {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
  }
}
