import { defineEventHandler } from 'h3'
import { serializeUser } from '~/server/utils/auth'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { user: serializeUser(user) }
})
