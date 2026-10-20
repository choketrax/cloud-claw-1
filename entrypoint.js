const http = require('http')
const https = require('https')
const net = require('net')
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const PORT = parseInt(process.env.PORT || '6658', 10)
const OPENCLAW_PORT = 18789
const WORKER_URL = process.env.WORKER_URL || 'https://cloud-claw-final.dl-56e.workers.dev'
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || 'cloud-claw'
const N8N_CONTROL_PLANE_URL =
  process.env.N8N_CONTROL_PLANE_URL || 'https://ai-n8n-engineer-control-plane.dl-56e.workers.dev'
const DISCOVERY_WORKER_URL =
  process.env.DISCOVERY_WORKER_URL || 'https://prospecting-discovery.dl-56e.workers.dev'
const DISCOVERY_API_SECRET = process.env.DISCOVERY_API_SECRET || 'production-secret-123'

const logs = []
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  logs.push(line)
  if (logs.length > 3000) logs.shift()
}

log(`Supervisor starting...`)
log(`PID: ${process.pid}, User ID: ${process.getuid ? process.getuid() : 'n/a'}`)
log(`Node: ${process.version}, Platform: ${process.platform}, Arch: ${process.arch}`)

let isOpenClawReady = false
let gatewayStatus = 'initializing'
let openclawProcess = null
let globalExecutable = null
let globalWorkspaceDir = '/data/workspace'

function approveDevice(requestId) {
  if (!globalExecutable || !requestId) return
  log(`[approveDevice] Triggering async approval for requestId=${requestId}`)

  const args1 = [
    ...globalExecutable.args,
    'devices',
    'approve',
    requestId,
    '--url',
    `ws://127.0.0.1:${OPENCLAW_PORT}`,
    '--token',
    GATEWAY_TOKEN,
  ]

  cp.execFile(
    globalExecutable.cmd,
    args1,
    {
      cwd: globalWorkspaceDir,
      env: process.env,
      timeout: 8000,
    },
    (err1, stdout1, stderr1) => {
      const out1 = ((stdout1 || '') + ' ' + (stderr1 || '')).trim()
      log(`[approveDevice with --url ${requestId}] exit=${err1 ? err1.code || 1 : 0} out=${out1}`)
      if (err1) {
        const args2 = [...globalExecutable.args, 'devices', 'approve', requestId]
        cp.execFile(
          globalExecutable.cmd,
          args2,
          {
            cwd: globalWorkspaceDir,
            env: {
              ...process.env,
              OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
            },
            timeout: 8000,
          },
          (err2, stdout2, stderr2) => {
            const out2 = ((stdout2 || '') + ' ' + (stderr2 || '')).trim()
            log(`[approveDevice local ${requestId}] exit=${err2 ? err2.code || 1 : 0} out=${out2}`)
          },
        )
      }
    },
  )
}

function getPendingRequestIds() {
  if (!globalExecutable) return []
  const ids = new Set()

  const attempts = [
    [
      ...globalExecutable.args,
      'devices',
      'list',
      '--json',
      '--url',
      `ws://127.0.0.1:${OPENCLAW_PORT}`,
      '--token',
      GATEWAY_TOKEN,
    ],
    [...globalExecutable.args, 'devices', 'list', '--json'],
  ]

  for (const args of attempts) {
    try {
      const res = cp.spawnSync(globalExecutable.cmd, args, {
        cwd: globalWorkspaceDir,
        env: {
          ...process.env,
          OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
        },
        encoding: 'utf8',
        timeout: 5000,
      })
      const out = res.stdout || ''
      if (out) {
        try {
          const parsed = JSON.parse(out)
          function scanObj(obj) {
            if (!obj) return
            if (Array.isArray(obj)) {
              for (const el of obj) scanObj(el)
            } else if (typeof obj === 'object') {
              if (obj.requestId) ids.add(obj.requestId)
              if (obj.id && obj.status === 'pending') ids.add(obj.id)
              for (const k of Object.keys(obj)) {
                if (k.toLowerCase().includes('pending') || k.toLowerCase().includes('request')) {
                  scanObj(obj[k])
                }
              }
            }
          }
          scanObj(parsed)
        } catch {}

        const matches = out.matchAll(/["']?requestId["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]+)["']?/gi)
        for (const m of matches) {
          ids.add(m[1])
        }
      }
      if (ids.size > 0) break
    } catch (err) {
      log(`[list devices error] ${err.message}`)
    }
  }

  return Array.from(ids)
}

function approveLatestAsync() {
  if (!globalExecutable || !isOpenClawReady) return
  log(`[approveLatestAsync] Triggering async --latest approval`)
  cp.execFile(
    globalExecutable.cmd,
    [
      ...globalExecutable.args,
      'devices',
      'approve',
      '--latest',
      '--url',
      `ws://127.0.0.1:${OPENCLAW_PORT}`,
      '--token',
      GATEWAY_TOKEN,
    ],
    {
      cwd: globalWorkspaceDir,
      env: process.env,
      timeout: 15000,
    },
    (err, stdout, stderr) => {
      const out = ((stdout || '') + ' ' + (stderr || '')).trim()
      log(`[approveLatestAsync] exit=${err ? err.code || 1 : 0} out=${out}`)
    },
  )
}

function getDashboardLink() {
  if (!globalExecutable) return 'OpenClaw not initialized'
  return `${WORKER_URL}/?token=${GATEWAY_TOKEN}`
}

function getCleanHeaders(incomingHeaders) {
  const clean = {}
  const forbidden = new Set([
    'x-real-ip',
    'forwarded',
    'via',
    'true-client-ip',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'authorization', // Do not forward Worker Basic Auth to OpenClaw
  ])

  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('cf-') ||
      lower.startsWith('tailscale-') ||
      forbidden.has(lower) ||
      lower === 'host'
    ) {
      continue
    }
    clean[key] = value
  }

  clean['host'] = `127.0.0.1:${OPENCLAW_PORT}`
  return clean
}

function proxyToN8n(targetPath, method, req, res) {
  const targetUrl = new URL(targetPath, N8N_CONTROL_PLANE_URL)
  log(`[n8n proxy] Forwarding ${method} ${req.url} -> ${targetUrl.toString()}`)
  const clientReq = https.request(
    targetUrl,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Cloud-Claw-Supervisor/1.0',
      },
    },
    (clientRes) => {
      res.writeHead(clientRes.statusCode, clientRes.headers)
      clientRes.pipe(res)
    },
  )
  clientReq.on('error', (err) => {
    log(`[n8n proxy error] ${err.message}`)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `N8N Control Plane unreachable: ${err.message}` }))
  })
  if (req.method === 'POST' || req.method === 'PUT') {
    req.pipe(clientReq)
  } else {
    clientReq.end()
  }
}

function proxyToDiscovery(targetPath, method, req, res) {
  const targetUrl = new URL(targetPath, DISCOVERY_WORKER_URL)
  log(`[discovery proxy] Forwarding ${method} ${req.url} -> ${targetUrl.toString()}`)
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Cloud-Claw-Supervisor/1.0',
    Authorization: `Bearer ${DISCOVERY_API_SECRET}`,
  }
  const clientReq = https.request(
    targetUrl,
    {
      method,
      headers,
    },
    (clientRes) => {
      res.writeHead(clientRes.statusCode, clientRes.headers)
      clientRes.pipe(res)
    },
  )
  clientReq.on('error', (err) => {
    log(`[discovery proxy error] ${err.message}`)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Discovery Worker unreachable: ${err.message}` }))
  })
  if (req.method === 'POST' || req.method === 'PUT') {
    req.pipe(clientReq)
  } else {
    clientReq.end()
  }
}

// 1. Start HTTP Server immediately so Cloudflare Containers probe succeeds instantly
const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost')
  const pathname = reqUrl.pathname

  // Always answer /health and /healthz with 200
  if (pathname === '/health' || pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('OK')
  }

  // Diagnostic endpoints
  if (pathname === '/_logs' || pathname === '/_status') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(`Status: ${gatewayStatus}\n\n=== RECENT LOGS ===\n` + logs.join('\n'))
  }

  // Device approval endpoint (non-blocking)
  if (pathname === '/_approve' || pathname === '/_devices') {
    if (!globalExecutable) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('OpenClaw executable not initialized yet')
    }
    const id = reqUrl.searchParams.get('id')
    if (id) {
      approveDevice(id)
    } else {
      approveLatestAsync()
    }
    const dashLink = getDashboardLink()
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(
      `=== OPENCLAW DEVICE PAIRING & APPROVAL ===\n\n` +
        `Triggered async approval for: ${id || '--latest'}\n` +
        `Dashboard URL: ${dashLink}\n\n` +
        `=== RECENT LOGS ===\n` +
        logs.slice(-25).join('\n'),
    )
  }

  // One-time Dashboard Link endpoint
  if (pathname === '/_dashboard' || pathname === '/_link') {
    const link = getDashboardLink()
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(`=== OPENCLAW ONE-TIME DASHBOARD LINK ===\n\n${link}\n`)
  }

  // n8n Control Plane Integration Endpoints
  if (pathname === '/_n8n' || pathname === '/_n8n/stats') {
    return proxyToN8n('/api/v1/stats', 'GET', req, res)
  }
  if (pathname === '/_n8n/clients') {
    return proxyToN8n('/api/v1/clients', req.method, req, res)
  }
  if (pathname === '/_n8n/workflows/build' && req.method === 'POST') {
    return proxyToN8n('/api/v1/workflows/build', 'POST', req, res)
  }
  if (pathname === '/_n8n/workflows') {
    return proxyToN8n('/api/v1/workflows', req.method, req, res)
  }
  if (pathname.startsWith('/_n8n/workflows/')) {
    const rest = pathname.replace('/_n8n/workflows/', '')
    return proxyToN8n(`/api/v1/workflows/${rest}`, req.method, req, res)
  }
  if (pathname.startsWith('/_n8n/webhooks/')) {
    const clientId = pathname.replace('/_n8n/webhooks/', '')
    return proxyToN8n(`/api/v1/clients/${clientId}/webhooks`, 'GET', req, res)
  }
  if (pathname.startsWith('/_n8n/executions/')) {
    const clientId = pathname.replace('/_n8n/executions/', '')
    return proxyToN8n(`/api/v1/clients/${clientId}/executions`, 'GET', req, res)
  }
  if (pathname === '/_n8n/trigger') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}')
        const { workflowSlug, clientId, token, payload = {} } = parsed
        if (!workflowSlug || !clientId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'workflowSlug and clientId are required' }))
        }
        const qs = token ? `?token=${encodeURIComponent(token)}` : ''
        const triggerUrl = new URL(
          `/v1/webhooks/${workflowSlug}/${clientId}${qs}`,
          N8N_CONTROL_PLANE_URL,
        )
        const postData = JSON.stringify(payload)
        log(`[n8n trigger] Dispatching to ${triggerUrl.toString()}`)
        const trigReq = https.request(
          triggerUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
          },
          (trigRes) => {
            res.writeHead(trigRes.statusCode, trigRes.headers)
            trigRes.pipe(res)
          },
        )
        trigReq.on('error', (err) => {
          log(`[n8n trigger error] ${err.message}`)
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Failed to trigger workflow: ${err.message}` }))
        })
        trigReq.write(postData)
        trigReq.end()
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Invalid JSON body: ${e.message}` }))
      }
    })
    return
  }

  // Prospect Discovery Engine Integration Endpoints
  if (pathname === '/_discovery/run' && req.method === 'POST') {
    return proxyToDiscovery('/discovery/run', 'POST', req, res)
  }
  if (pathname === '/_discovery/prospects') {
    return proxyToDiscovery(`/discovery/prospects${reqUrl.search}`, 'GET', req, res)
  }
  if (pathname === '/_discovery/feedback' && req.method === 'POST') {
    return proxyToDiscovery('/discovery/feedback', 'POST', req, res)
  }
  if (pathname.startsWith('/_discovery/run/')) {
    const runId = pathname.replace('/_discovery/run/', '')
    return proxyToDiscovery(`/discovery/run/${runId}`, 'GET', req, res)
  }

  if (isOpenClawReady) {
    const cleanHeaders = getCleanHeaders(req.headers)

    let targetPath = reqUrl.pathname + reqUrl.search
    if (reqUrl.pathname !== '/' && reqUrl.searchParams.has('token')) {
      const sanitized = new URL(reqUrl.toString())
      sanitized.searchParams.delete('token')
      targetPath = sanitized.pathname + sanitized.search
    }

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: OPENCLAW_PORT,
        path: targetPath,
        method: req.method,
        headers: cleanHeaders,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )

    proxyReq.on('error', (err) => {
      log(`Proxy error to OpenClaw: ${err.message}`)
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Proxy Error: ${err.message}\n\n=== LOGS ===\n` + logs.slice(-60).join('\n'))
    })

    req.pipe(proxyReq)
  } else {
    // OpenClaw is still booting or encountered an error.
    // Return 200 with HTML/text containing the live logs so browser displays status directly!
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '5',
      Refresh: '5',
    })
    res.end(
      `OpenClaw Gateway status: [${gatewayStatus}]\n` +
        `The page will automatically refresh every 5 seconds until OpenClaw is ready.\n\n` +
        `=== LIVE CONTAINER LOGS ===\n` +
        logs.join('\n'),
    )
  }
})

// WebSocket proxy for OpenClaw Gateway / UI
server.on('upgrade', (req, socket, head) => {
  // Pause socket until target connection is established to avoid data frame drop
  socket.pause()

  const connectToOpenClaw = () => {
    const cleanHeaders = getCleanHeaders(req.headers)
    log(`WS upgrade: ${req.method} ${req.url} -> direct-local`)

    const targetSocket = net.connect(OPENCLAW_PORT, '127.0.0.1', () => {
      let targetUrl = req.url
      if (!targetUrl.includes('token=')) {
        targetUrl += (targetUrl.includes('?') ? '&' : '?') + `token=${GATEWAY_TOKEN}`
      }
      let rawHeaders = `${req.method} ${targetUrl} HTTP/1.1\r\n`
      for (const [key, value] of Object.entries(cleanHeaders)) {
        if (Array.isArray(value)) {
          for (const v of value) rawHeaders += `${key}: ${v}\r\n`
        } else if (value !== undefined) {
          rawHeaders += `${key}: ${value}\r\n`
        }
      }
      rawHeaders += '\r\n'

      targetSocket.write(rawHeaders)
      if (head && head.length > 0) {
        targetSocket.write(head)
      }

      // Inspect outgoing server->client WS frames for NOT_PAIRED / requestId as a fallback
      targetSocket.on('data', (chunk) => {
        try {
          const str = chunk.toString('utf8')
          if (str.includes('NOT_PAIRED') || str.includes('pairing required')) {
            const m = str.match(/"requestId"\s*:\s*"([a-f0-9-]{8,})"/i)
            if (m && m[1]) {
              log(`[ws-sniffer] Detected NOT_PAIRED frame with requestId=${m[1]}, auto-approving!`)
              approveDevice(m[1])
            } else {
              log(`[ws-sniffer] Detected NOT_PAIRED frame, triggering --latest approval!`)
              approveLatestAsync()
            }
          }
        } catch {}
      })

      socket.pipe(targetSocket)
      targetSocket.pipe(socket)
      socket.resume()
    })

    targetSocket.on('error', (err) => {
      log(`WS target socket error: ${err.message}`)
      socket.destroy()
    })

    socket.on('error', (err) => {
      log(`WS client socket error: ${err.message}`)
      targetSocket.destroy()
    })
  }

  if (isOpenClawReady) {
    connectToOpenClaw()
  } else {
    log(`WS upgrade requested while OpenClaw not ready (status: ${gatewayStatus}), waiting up to 20s...`)
    let attempts = 0
    const interval = setInterval(() => {
      attempts++
      if (isOpenClawReady) {
        clearInterval(interval)
        connectToOpenClaw()
      } else if (attempts >= 40) {
        clearInterval(interval)
        log(`WS upgrade timed out waiting for OpenClaw ready`)
        socket.destroy()
      }
    }, 500)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  log(`Container HTTP Supervisor listening on 0.0.0.0:${PORT}`)
  initializeAndLaunch()
})

// 2. Setup Environment and Launch OpenClaw
async function initializeAndLaunch() {
  try {
    const stateDir = '/data'
    const workspaceDir = '/data/workspace'
    const compileCacheDir = '/var/tmp/openclaw-compile-cache'

    // Ensure directories exist
    for (const dir of [
      stateDir,
      workspaceDir,
      '/home/node/.openclaw',
      '/root/.openclaw',
      compileCacheDir,
    ]) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        log(`Warning creating dir ${dir}: ${e.message}`)
      }
    }

    // Patch OpenClaw bundle for 0ms inline silent pairing of Control UI / Operator browsers
    try {
      const distDir = '/app/dist'
      if (fs.existsSync(distDir)) {
        for (const f of fs.readdirSync(distDir)) {
          if (!f.endsWith('.mjs')) continue
          const p = path.join(distDir, f)
          let c = fs.readFileSync(p, 'utf8')
          let modified = false
          const target1 = 'function resolveLocalPairingApproval(params) {'
          const patch1 =
            'function resolveLocalPairingApproval(params) {\n\tif (params?.state?.isControlUi || params?.state?.isWebchat || params?.state?.role === "operator") return "silent";'
          if (c.includes(target1) && !c.includes('params?.state?.isControlUi || params?.state?.isWebchat')) {
            c = c.replace(target1, patch1)
            modified = true
          }
          const target2 = 'function shouldAllowSilentLocalPairing(params) {'
          const patch2 =
            'function shouldAllowSilentLocalPairing(params) {\n\tif (params?.isControlUi || params?.isWebchat) return true;'
          if (c.includes(target2) && !c.includes('if (params?.isControlUi || params?.isWebchat) return true;')) {
            c = c.replace(target2, patch2)
            modified = true
          }
          if (modified) {
            fs.writeFileSync(p, c, 'utf8')
            log(`[silent-pairing] Patched ${p} for instant 0ms Control UI pairing`)
          }
        }
      }
    } catch (e) {
      log(`[silent-pairing] Warning patching dist: ${e.message}`)
    }

    // Set process env
    process.env.OPENCLAW_STATE_DIR = stateDir
    process.env.OPENCLAW_WORKSPACE_DIR = workspaceDir
    process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json')
    process.env.NODE_COMPILE_CACHE = compileCacheDir
    process.env.OPENCLAW_NO_RESPAWN = '1'

    // Create strictly validated openclaw.json (no retired keys, so no 30s doctor --fix needed!)
    const config = {
      gateway: {
        mode: 'local',
        bind: 'lan',
        port: OPENCLAW_PORT,
        auth: {
          mode: 'token',
          token: GATEWAY_TOKEN,
        },
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true,
          allowedOrigins: [
            '*',
            WORKER_URL,
            'https://cloud-claw-final.dl-56e.workers.dev',
            `http://localhost:${PORT}`,
            `http://127.0.0.1:${PORT}`,
            `http://localhost:${OPENCLAW_PORT}`,
            `http://127.0.0.1:${OPENCLAW_PORT}`,
            'http://container',
          ],
        },
      },
      browser: {
        enabled: true,
        defaultProfile: 'cloudflare',
        profiles: {
          cloudflare: {
            cdpUrl: `${WORKER_URL}/cloudflare.browser/${GATEWAY_TOKEN}`,
            driver: 'openclaw',
          },
        },
      },
      tools: {
        profile: 'coding',
        allow: ['*'],
      },
      models: {
        mode: 'merge',
        providers: {
          freellmapi: {
            baseUrl: 'https://weights-weekly-recognized-pixel.trycloudflare.com/v1',
            apiKey: 'freellmapi-2de4a19794bfd86bb9883f2b020bd8ff0c0ac5f14cba8cd5',
            api: 'openai-completions',
            models: [
              {
                id: 'auto',
                name: 'FreeLLMAPI Auto Router',
                contextWindow: 16000,
                maxTokens: 1024,
              },
              {
                id: 'openai/gpt-oss-120b',
                name: 'GPT OSS 120B (Groq)',
                contextWindow: 16000,
                maxTokens: 1024,
              },
              {
                id: 'openai/gpt-oss-20b',
                name: 'GPT OSS 20B (Groq)',
                contextWindow: 16000,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'freellmapi/auto',
          },
        },
      },
    }

    const configContent = JSON.stringify(config, null, 2)
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), configContent, 'utf8')
    try {
      fs.writeFileSync('/home/node/.openclaw/openclaw.json', configContent, 'utf8')
      fs.writeFileSync('/root/.openclaw/openclaw.json', configContent, 'utf8')
    } catch {}

    log(`Config written to ${path.join(stateDir, 'openclaw.json')}`)

    // Auto-provision n8n Engineer Control Plane Skill
    setupN8nSkill(workspaceDir, stateDir)

    // Auto-provision B2B Prospect Discovery Engine Skill
    setupDiscoverySkill(workspaceDir, stateDir)

    // Find OpenClaw executable
    globalWorkspaceDir = workspaceDir
    const executable = findExecutable()
    globalExecutable = executable
    if (!executable) {
      gatewayStatus = 'binary_not_found'
      log(`FATAL: Could not locate OpenClaw executable!`)
      listDebugPaths()
      return
    }

    launchGateway(executable, workspaceDir)
  } catch (err) {
    gatewayStatus = `init_error: ${err.message}`
    log(`Initialization error: ${err.stack || err.message}`)
  }
}

function setupN8nSkill(workspaceDir, stateDir) {
  const skillContent = `---
name: n8n-engineer
description: Multi-tenant n8n Workflow Builder and Automation Control Plane. Use to build new n8n workflows from natural language specs, export n8n JSON, list workflows, trigger automations, inspect execution logs, and onboard clients.
---

# n8n Engineer Control Plane & Workflow Builder

You have direct access to the multi-tenant n8n automation control plane and deterministic workflow builder running at:
\`https://ai-n8n-engineer-control-plane.dl-56e.workers.dev\`
(or locally via \`http://127.0.0.1:${PORT}/_n8n\`)

## Available Operations

### 1. Build a New Custom n8n Workflow (Deterministic Builder)
Build, validate, and register a brand-new n8n workflow (returns complete importable n8n JSON + live webhook endpoints):
\`\`\`bash
curl -s -X POST "http://127.0.0.1:${PORT}/_n8n/workflows/build" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Custom Lead Enrichment & Slack Alert",
    "description": "Enriches incoming webhook leads and posts high-score prospects to Slack",
    "category": "sales",
    "triggerType": "webhook",
    "steps": [
      {"name": "Enrich Company", "type": "http", "url": "https://api.company.com/enrich", "method": "POST"},
      {"name": "Check Score", "type": "if"},
      {"name": "Alert Sales Channel", "type": "slack", "channel": "#sales-alerts"}
    ]
  }'
\`\`\`

### 2. List All Workflow Templates & Export n8n JSON
\`\`\`bash
curl -s "http://127.0.0.1:${PORT}/_n8n/workflows"
curl -s "http://127.0.0.1:${PORT}/_n8n/workflows/<workflowIdOrSlug>/json"
\`\`\`

### 3. List Clients
Fetch all registered clients and their execution quotas:
\`\`\`bash
curl -s "https://ai-n8n-engineer-control-plane.dl-56e.workers.dev/api/v1/clients"
\`\`\`

### 4. List Client Webhooks & Workflows
Get all active webhook URLs for a specific client:
\`\`\`bash
curl -s "https://ai-n8n-engineer-control-plane.dl-56e.workers.dev/api/v1/clients/<clientId>/webhooks"
\`\`\`

Available Built-In Workflow Slugs:
- \`lead-capture-and-routing\`: Universal Lead Capture & Routing
- \`sales-pipeline-follow-up\`: Sales Pipeline Stalled Deal Acceleration
- \`crm-sync-and-deduplication\`: Bi-Directional CRM Sync & Deduplication
- \`customer-support-triage\`: Customer Support Triage & SLA Router
- \`appointment-booking-and-follow-up\`: Appointment Booking & Follow-Up
- \`ai-content-approval-and-publishing\`: AI Content Approval & Publishing
- \`document-approval-workflow\`: Document & Contract Approval
- \`ecommerce-order-exception-handling\`: E-Commerce Order Exception Handling
- \`employee-onboarding-and-offboarding\`: Employee Onboarding & Lifecycle
- \`invoice-collections-follow-up\`: Automated Invoice Collections

### 5. Trigger a Workflow
Dispatch an event to an active client workflow:
\`\`\`bash
curl -X POST "https://ai-n8n-engineer-control-plane.dl-56e.workers.dev/v1/webhooks/<workflowSlug>/<clientId>?token=<webhookSecret>" \\
  -H "Content-Type: application/json" \\
  -d '{"key": "value"}'
\`\`\`

### 6. Check Execution Logs & Status
Query the execution history and duration metrics:
\`\`\`bash
curl -s "https://ai-n8n-engineer-control-plane.dl-56e.workers.dev/api/v1/clients/<clientId>/executions"
\`\`\`

### 7. Onboard New Client
Provision a new client tenant with all enterprise workflows automatically:
\`\`\`bash
curl -X POST "https://ai-n8n-engineer-control-plane.dl-56e.workers.dev/api/v1/clients" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Client Name", "slug": "client-slug", "plan": "enterprise", "monthlyQuota": 25000}'
\`\`\`

### 8. Platform Stats
Check overall system metrics across all clients:
\`\`\`bash
curl -s "https://ai-n8n-engineer-control-plane.dl-56e.workers.dev/api/v1/stats"
\`\`\`
`

  for (const base of [workspaceDir, path.join(stateDir, 'skills'), '/root/.openclaw/skills']) {
    try {
      const skillDir = path.join(base, 'skills', 'n8n-engineer')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8')
      log(`[n8n-skill] Written skill to ${path.join(skillDir, 'SKILL.md')}`)
    } catch (e) {
      log(`[n8n-skill] Note: ${e.message}`)
    }
  }
}

function setupDiscoverySkill(workspaceDir, stateDir) {
  const skillContent = `---
name: prospect-discovery
description: Production B2B Prospect Discovery Engine. Use to trigger autonomous ICP discovery runs, check discovery status, list qualified prospects with evidence, and record operator feedback.
---

# B2B Prospect Discovery Engine

You have direct access to the autonomous Prospect Discovery Engine running via the internal supervisor proxy:
\`http://127.0.0.1:${PORT}/_discovery\`

All calls through this proxy automatically authenticate with the discovery worker using server-side credentials.

## Available Operations

### 1. Trigger an ICP Discovery Run
Start a background discovery pipeline by providing an Ideal Customer Profile:
\`\`\`bash
curl -X POST "http://127.0.0.1:${PORT}/_discovery/run" \\
  -H "Content-Type: application/json" \\
  -d '{
    "icp": {
      "product": "AI Infrastructure Cost Audit",
      "offer": "Cut inference and LLM pipeline costs by 30-50%",
      "targetMarket": "B2B SaaS companies building generative AI features",
      "idealCustomer": "VP of Engineering, CTO, or Head of AI with high token volume",
      "geography": "US, Canada, UK, EU",
      "negativeCriteria": ["consulting agencies", "pre-revenue startups", "crypto/web3"]
    },
    "maxResults": 50,
    "concurrency": 5,
    "minQualificationScore": 60,
    "fullEnrichmentScore": 85,
    "maxDiscoveryCostPerRun": 5.00
  }'
\`\`\`
Returns: \`{"runId": "<uuid>", "status": "started"}\`

### 2. Check Discovery Run Status & Summary
Poll the status and cost telemetry of a running or completed discovery job:
\`\`\`bash
curl -s "http://127.0.0.1:${PORT}/_discovery/run/<runId>"
\`\`\`

### 3. List Discovered & Qualified Prospects
Retrieve prospects ranked by multi-factor score (ICP fit, pain strength, timing, evidence quality, reachability, commercial value):
\`\`\`bash
curl -s "http://127.0.0.1:${PORT}/_discovery/prospects?minScore=60&limit=20"
\`\`\`
Supported query parameters:
- \`status\`: Filter by lifecycle state (\`new\`, \`qualified\`, \`rejected\`, \`queued\`, \`contacted\`, \`customer\`, etc.)
- \`minScore\`: Minimum overall score from 0-100 (e.g. \`70\`)
- \`limit\`: Number of prospects to return (e.g. \`20\`)
- \`offset\`: Pagination offset

### 4. Record Operator Feedback
Provide human feedback on a prospect to refine future search queries and model preferences:
\`\`\`bash
curl -X POST "http://127.0.0.1:${PORT}/_discovery/feedback" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prospectId": "<prospectId>",
    "verdict": "KEEP",
    "reason": "Owner-operated AI SaaS with clear inference spend"
  }'
\`\`\`
Verdicts: \`KEEP\`, \`MAYBE\`, \`REJECT\`
`

  for (const base of [workspaceDir, path.join(stateDir, 'skills'), '/root/.openclaw/skills']) {
    try {
      const skillDir = path.join(base, 'skills', 'prospect-discovery')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8')
      log(`[discovery-skill] Written skill to ${path.join(skillDir, 'SKILL.md')}`)
    } catch (e) {
      log(`[discovery-skill] Note: ${e.message}`)
    }
  }
}

function findExecutable() {
  // Check common binary names and paths
  const directBinaries = ['openclaw', '/usr/local/bin/openclaw', '/usr/bin/openclaw']
  for (const bin of directBinaries) {
    try {
      const res = cp.spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 })
      if (res.status === 0 || (res.stdout && res.stdout.length > 0)) {
        log(`Found working binary via '${bin}': ${(res.stdout || '').trim()}`)
        return { cmd: bin, args: [] }
      }
    } catch {}
  }

  // Check node scripts
  const scriptCandidates = [
    '/app/openclaw.mjs',
    '/app/dist/index.js',
    '/home/node/openclaw.mjs',
    '/home/node/dist/index.js',
    '/openclaw/openclaw.mjs',
    '/openclaw/dist/index.js',
  ]

  for (const script of scriptCandidates) {
    if (fs.existsSync(script)) {
      log(`Found OpenClaw script at ${script}`)
      return { cmd: process.execPath, args: [script] }
    }
  }

  // Search in /app
  try {
    if (fs.existsSync('/app')) {
      const files = fs.readdirSync('/app')
      log(`Files in /app: ${files.join(', ')}`)
      for (const f of files) {
        if (f.endsWith('.mjs') || f.endsWith('.js')) {
          log(`Found candidate script /app/${f}`)
          return { cmd: process.execPath, args: [`/app/${f}`] }
        }
      }
    }
  } catch (e) {
    log(`Error searching /app: ${e.message}`)
  }

  return null
}

function listDebugPaths() {
  for (const p of ['/app', '/usr/local/bin', '/home/node']) {
    try {
      if (fs.existsSync(p)) {
        log(`Contents of ${p}: ${fs.readdirSync(p).join(', ')}`)
      }
    } catch (e) {
      log(`Could not read ${p}: ${e.message}`)
    }
  }
}

function launchGateway(executable, cwd) {
  gatewayStatus = 'starting'
  const args = [
    ...executable.args,
    'gateway',
    '--port',
    OPENCLAW_PORT.toString(),
    '--bind',
    'lan',
    '--token',
    GATEWAY_TOKEN,
    '--allow-unconfigured',
  ]

  log(`Spawning OpenClaw: ${executable.cmd} ${args.join(' ')}`)

  openclawProcess = cp.spawn(executable.cmd, args, {
    cwd,
    env: {
      ...process.env,
      PORT: OPENCLAW_PORT.toString(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  openclawProcess.stdout.on('data', (data) => {
    const lines = data.toString('utf8').trim().split('\n')
    for (const l of lines) {
      log(`[openclaw stdout] ${l}`)
    }
  })

  openclawProcess.stderr.on('data', (data) => {
    const lines = data.toString('utf8').trim().split('\n')
    for (const l of lines) {
      log(`[openclaw stderr] ${l}`)
      const m = l.match(/requestId[:=\s]+([a-zA-Z0-9_-]+)/i)
      if (
        m &&
        (l.includes('pairing required') ||
          l.includes('not approved yet') ||
          l.includes('reason=not-paired'))
      ) {
        log(`[auto-approve trigger] Found unapproved device requestId=${m[1]}`)
        approveDevice(m[1])
      }
    }
  })

  openclawProcess.on('exit', (code, signal) => {
    isOpenClawReady = false
    gatewayStatus = `exited (code ${code}, signal ${signal})`
    log(`OpenClaw process exited with code ${code}, signal ${signal}. Restarting in 2s...`)
    setTimeout(() => {
      if (globalExecutable) launchGateway(globalExecutable, globalWorkspaceDir)
    }, 2000)
  })

  openclawProcess.on('error', (err) => {
    isOpenClawReady = false
    gatewayStatus = `spawn_error: ${err.message}`
    log(`OpenClaw spawn error: ${err.message}. Restarting in 3s...`)
    setTimeout(() => {
      if (globalExecutable) launchGateway(globalExecutable, globalWorkspaceDir)
    }, 3000)
  })

  // Poll OpenClaw port until ready
  pollPort()
}

function pollPort() {
  if (isOpenClawReady) return

  const req = http.get(`http://127.0.0.1:${OPENCLAW_PORT}/`, (res) => {
    log(`OpenClaw port ${OPENCLAW_PORT} responded with HTTP ${res.statusCode}! Marking READY.`)
    isOpenClawReady = true
    gatewayStatus = 'ready'
  })

  req.on('error', () => {
    // Retry in 1 second if still running
    if (gatewayStatus === 'starting') {
      setTimeout(pollPort, 1000)
    }
  })

  req.setTimeout(1000, () => req.destroy())
}
