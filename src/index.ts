import { env } from 'cloudflare:workers'
import { proxyCdp } from './cdp'
import { forwardRequestToContainer } from './container'

export { AgentContainer } from './container'

function checkAuth(request: Request, url: URL): { ok: boolean; setCookie?: string } {
  const username = env.SERVER_USERNAME
  const password = env.SERVER_PASSWORD

  // If no password configured, auth is disabled
  if (!password) {
    return { ok: true }
  }

  const expected = btoa(`${username || 'admin'}:${password}`)

  // 1. Check session cookie
  const cookieHeader = request.headers.get('Cookie') || ''
  const cookies: Record<string, string> = {}
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=')
    if (eqIdx !== -1) {
      cookies[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim()
    }
  }
  if (cookies['cf_auth'] === expected) {
    return { ok: true }
  }

  // 2. Check Bearer token auth (matches OpenClaw gateway token or server password)
  const authorization = request.headers.get('Authorization')
  if (authorization?.startsWith('Bearer ')) {
    const bearer = authorization.slice(7).trim()
    if (bearer === env.OPENCLAW_GATEWAY_TOKEN || bearer === password) {
      return { ok: true }
    }
  }

  // 3. Check query parameter token
  const queryToken = url.searchParams.get('token')
  if (queryToken && (queryToken === env.OPENCLAW_GATEWAY_TOKEN || queryToken === password)) {
    return {
      ok: true,
      setCookie: `cf_auth=${expected}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`,
    }
  }

  // 4. Check Basic Auth
  if (authorization?.startsWith('Basic ')) {
    const provided = authorization.slice(6).trim()
    if (provided === expected) {
      return {
        ok: true,
        setCookie: `cf_auth=${expected}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`,
      }
    }
  }

  // 5. Allow public static assets and icons without auth challenges
  if (
    url.pathname === '/favicon.ico' ||
    url.pathname === '/robots.txt' ||
    url.pathname.startsWith('/assets/')
  ) {
    return { ok: true }
  }

  return { ok: false }
}

async function handleFetch(request: Request) {
  const url = new URL(request.url)

  // /cloudflare.browser/{token} — token auth via URL path
  const browserMatch = url.pathname.match(/^\/cloudflare\.browser\/([^/]+)(.*)/)
  if (browserMatch) {
    const [, token] = browserMatch
    if (!env.OPENCLAW_GATEWAY_TOKEN || token !== env.OPENCLAW_GATEWAY_TOKEN) {
      return new Response('Unauthorized', { status: 401 })
    }
    const host = request.headers.get('Host') || url.host
    return proxyCdp(env.BROWSER, request, `${url.protocol}//${host}`, token)
  }

  // WebSocket upgrades are forwarded directly to the container.
  // We MUST pass `request` directly without `new Request()` to preserve workerd's native WebSocket transport handle.
  // The supervisor entrypoint attaches the gateway token automatically if not present in the URL.
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    return forwardRequestToContainer(request)
  }

  // Verify authentication
  const auth = checkAuth(request, url)
  if (!auth.ok) {
    const isDocumentNavigation =
      request.headers.get('Sec-Fetch-Dest') === 'document' ||
      (request.headers.get('Accept')?.includes('text/html') &&
        !request.headers.get('Accept')?.includes('application/json'))

    // Only send WWW-Authenticate on direct top-level browser page loads.
    // Never send WWW-Authenticate on subrequests or API calls, which triggers browser popup loops.
    const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' }
    if (isDocumentNavigation) {
      headers['WWW-Authenticate'] = 'Basic realm="Agent"'
    }
    return new Response('Unauthorized', { status: 401, headers })
  }

  // If user visits any UI document page via browser without ?token=, redirect to include the gateway token
  // so the Control UI automatically ingests and persists it into sessionStorage!
  const isDocumentNavigation =
    request.headers.get('Sec-Fetch-Dest') === 'document' ||
    (request.headers.get('Accept')?.includes('text/html') &&
      !request.headers.get('Accept')?.includes('application/json'))

  if (
    isDocumentNavigation &&
    !url.pathname.startsWith('/assets/') &&
    !url.pathname.startsWith('/cloudflare.browser') &&
    !url.pathname.startsWith('/_') &&
    !url.searchParams.has('token')
  ) {
    const gatewayToken = env.OPENCLAW_GATEWAY_TOKEN || 'cloud-claw'
    url.searchParams.set('token', gatewayToken)
    const headers: Record<string, string> = {
      'Location': url.toString(),
    }
    if (auth.setCookie) {
      headers['Set-Cookie'] = auth.setCookie
    }
    return new Response(null, {
      status: 302,
      headers,
    })
  }

  const response = await forwardRequestToContainer(request)

  // If newly authenticated via Basic Auth or token, attach Set-Cookie
  if (auth.setCookie) {
    const newHeaders = new Headers(response.headers)
    newHeaders.append('Set-Cookie', auth.setCookie)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    })
  }

  return response
}

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Cloudflare.Env>
