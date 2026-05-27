export default defineNuxtRouteMiddleware((to) => {
  if (!to.path.startsWith('/admin')) return

  const { loggedIn, session } = useUserSession()

  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }

  const user = session.value?.user as { isAdmin?: boolean } | undefined
  if (!user?.isAdmin) {
    return navigateTo('/welcome')
  }
})
