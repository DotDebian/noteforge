/**
 * Global route middleware. Anyone hitting a non-public route without a
 * session gets bounced to /login. Logged-in users visiting /login or
 * /register get sent to the workspace router (/).
 *
 * `/share/<token>` (Sprint 5 / F9) is public: unauthenticated visitors
 * must reach it, but logged-in users should NOT be bounced to `/` either —
 * they may also want to view the link as a guest.
 *
 * `/` is also public — for logged-out visitors it renders the marketing
 * landing page; for logged-in users it bootstraps the workspace router.
 * The branching lives in pages/index.vue.
 */
const AUTH_ROUTES = new Set(['/login', '/register', '/recover'])

function isShareRoute(path: string): boolean {
  return path === '/share' || path.startsWith('/share/')
}

export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()
  const isAuthRoute = AUTH_ROUTES.has(to.path)
  const isLanding = to.path === '/'
  const isPublic = isAuthRoute || isLanding || isShareRoute(to.path)

  if (!loggedIn.value && !isPublic) {
    return navigateTo({
      path: '/login',
      query: to.fullPath !== '/' ? { redirect: to.fullPath } : undefined,
    })
  }

  // Logged-in users visiting /login or /register get bounced to / — but
  // not when visiting a /share/* link (they may want to see the public
  // view as a guest would).
  if (loggedIn.value && isAuthRoute) {
    return navigateTo('/')
  }
})
