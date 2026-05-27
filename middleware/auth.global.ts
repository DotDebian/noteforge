/**
 * Global route middleware. Anyone hitting a non-public route without a
 * session gets bounced to /login. Logged-in users visiting /login or
 * /register get sent to /welcome (which handles the workspace bootstrap).
 *
 * `/share/<token>` (Sprint 5 / F9) is public: unauthenticated visitors
 * must reach it, but logged-in users should NOT be bounced either —
 * they may also want to view the link as a guest.
 *
 * `/` is public and serves the marketing landing. Logged-in users hitting
 * it are bounced to `/welcome` so they never render the `landing` layout
 * (which would flash before flipping to `default` and leaving the root
 * `<NuxtLayout>` desynchronised after the workspace redirect).
 *
 * `/welcome` is logged-in-only — the workspace bootstrap page.
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

  // Logged-in users skip the marketing landing entirely — straight to the
  // workspace bootstrap. Also bounce them off /login and /register.
  if (loggedIn.value && (isAuthRoute || isLanding)) {
    return navigateTo('/welcome')
  }
})
