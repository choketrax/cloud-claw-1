const http = require('http')
const net = require('net')
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const PORT = parseInt(process.env.PORT || '6658', 10)
const OPENCLAW_PORT = 18789
const WORKER_URL = process.env.WORKER_URL || 'https://cloud-claw-final.dl-56e.workers.dev'
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || 'cloud-claw'

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
  if (!globalExecutable || !requestId) return ''
  log(`[approveDevice] Attempting approval for requestId=${requestId}`)

  // 1. Try with --url and --token via WebSocket RPC
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
  try {
    const res1 = cp.spawnSync(globalExecutable.cmd, args1, {
      cwd: globalWorkspaceDir,
      env: process.env,
      encoding: 'utf8',
      timeout: 10000,
    })
    const out1 = ((res1.stdout || '') + ' ' + (res1.stderr || '')).trim()
    log(`[approveDevice with --url ${requestId}] exit=${res1.status} out=${out1}`)
    if (res1.status === 0) return out1
  } catch (err) {
    log(`[approveDevice with --url error] ${err.message}`)
  }

  // 2. Try local CLI mode
  const args2 = [
    ...globalExecutable.args,
    'devices',
    'approve',
    requestId,
  ]
  try {
    const res2 = cp.spawnSync(globalExecutable.cmd, args2, {
      cwd: globalWorkspaceDir,
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
      },
      encoding: 'utf8',
      timeout: 10000,
    })
    const out2 = ((res2.stdout || '') + ' ' + (res2.stderr || '')).trim()
    log(`[approveDevice local ${requestId}] exit=${res2.status} out=${out2}`)
    return out2
  } catch (err) {
    log(`[approveDevice local error] ${err.message}`)
    return err.message
  }
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
    [
      ...globalExecutable.args,
      'devices',
      'list',
      '--json',
    ],
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

function approveAllPending() {
  if (!globalExecutable || !isOpenClawReady) return []

  // 1. Instantly approve the latest pairing request if any
  try {
    cp.spawnSync(
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
        timeout: 3000,
      },
    )
  } catch {}
  try {
    cp.spawnSync(
      globalExecutable.cmd,
      [
        ...globalExecutable.args,
        'devices',
        'approve',
        '--latest',
      ],
      {
        cwd: globalWorkspaceDir,
        env: {
          ...process.env,
          OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
        },
        timeout: 3000,
      },
    )
  } catch {}

  const ids = getPendingRequestIds()
  const results = []
  for (const id of ids) {
    const res = approveDevice(id)
    results.push({ id, res })
  }
  return results
}

function getDashboardLink() {
  if (!globalExecutable) return 'OpenClaw not initialized'
  try {
    const res = cp.spawnSync(
      globalExecutable.cmd,
      [
        ...globalExecutable.args,
        'dashboard',
        '--no-open',
      ],
      {
        cwd: globalWorkspaceDir,
        env: {
          ...process.env,
          OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    )
    let out = ((res.stdout || '') + '\n' + (res.stderr || '')).trim()
    out = out.replace(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g, WORKER_URL)
    return out
  } catch (err) {
    return `Error generating dashboard link: ${err.message}`
  }
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

  // Extract or synthesize a valid non-loopback client IP for OpenClaw trusted-proxy attribution
  let clientIp =
    incomingHeaders['cf-connecting-ip'] ||
    (typeof incomingHeaders['x-forwarded-for'] === 'string'
      ? incomingHeaders['x-forwarded-for'].split(',')[0].trim()
      : undefined) ||
    incomingHeaders['x-real-ip'] ||
    '1.1.1.1'

  if (
    !clientIp ||
    clientIp.startsWith('127.') ||
    clientIp === '::1' ||
    clientIp === 'localhost' ||
    clientIp === 'unknown'
  ) {
    clientIp = '1.1.1.1'
  }

  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('cf-') ||
      forbidden.has(lower) ||
      lower === 'host'
    ) {
      continue
    }
    clean[key] = value
  }

  clean['host'] = `127.0.0.1:${OPENCLAW_PORT}`
  clean['x-forwarded-for'] = clientIp
  clean['x-forwarded-proto'] = 'https'
  clean['x-forwarded-user'] = 'agili'
  clean['x-openclaw-scopes'] =
    'operator.read,operator.write,operator.approvals,operator.questions,operator.admin'
  return clean
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

  // Device approval endpoint
  if (pathname === '/_approve' || pathname === '/_devices') {
    if (!globalExecutable) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('OpenClaw executable not initialized yet')
    }
    const id = reqUrl.searchParams.get('id')
    let output = ''
    if (id) {
      output = `Approving requested ID [${id}]:\n` + approveDevice(id)
    } else {
      const approved = approveAllPending()
      output = `Auto-approved pending devices: ${JSON.stringify(approved, null, 2)}\n\n`

      try {
        const listRes = cp.spawnSync(
          globalExecutable.cmd,
          [
            ...globalExecutable.args,
            'devices',
            'list',
            '--url',
            `ws://127.0.0.1:${OPENCLAW_PORT}`,
            '--token',
            GATEWAY_TOKEN,
          ],
          {
            cwd: globalWorkspaceDir,
            env: {
              ...process.env,
              OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
            },
            encoding: 'utf8',
            timeout: 5000,
          },
        )
        output += `Current Device List:\n${listRes.stdout || ''}\n${listRes.stderr || ''}`
      } catch (err) {
        output += `Error listing devices: ${err.message}`
      }
      const dashLink = getDashboardLink()
      output += `\n\n=== ONE-TIME PAIRING DASHBOARD LINK ===\n${dashLink}\n`
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(
      `=== OPENCLAW DEVICE PAIRING & APPROVAL ===\n\n${output}\n\n=== RECENT LOGS ===\n` +
        logs.slice(-25).join('\n'),
    )
  }

  // One-time Dashboard Link endpoint
  if (pathname === '/_dashboard' || pathname === '/_link') {
    const link = getDashboardLink()
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(`=== OPENCLAW ONE-TIME DASHBOARD LINK ===\n\n${link}\n`)
  }

  if (isOpenClawReady) {
    const cleanHeaders = getCleanHeaders(req.headers)

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: OPENCLAW_PORT,
        path: reqUrl.pathname + reqUrl.search,
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
      'Refresh': '5',
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
  if (!isOpenClawReady) {
    log(`WS upgrade requested while OpenClaw not ready (status: ${gatewayStatus})`)
    socket.destroy()
    return
  }

  // Pause socket until target connection is established to avoid data frame drop
  socket.pause()

  const cleanHeaders = getCleanHeaders(req.headers)
  log(`WS upgrade: ${req.method} ${req.url} clientIp=${cleanHeaders['x-forwarded-for']}`)

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

    // Ensure directories exist
    for (const dir of [stateDir, workspaceDir, '/home/node/.openclaw', '/root/.openclaw']) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        log(`Warning creating dir ${dir}: ${e.message}`)
      }
    }

    // Set process env
    process.env.OPENCLAW_STATE_DIR = stateDir
    process.env.OPENCLAW_WORKSPACE_DIR = workspaceDir
    process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json')

    // Create openclaw.json with valid current schema and trustedProxies
    const config = {
      gateway: {
        mode: 'local',
        bind: 'lan',
        port: OPENCLAW_PORT,
        trustedProxies: ['127.0.0.1', '::ffff:127.0.0.1', '::1'],
        nodes: {
          pairing: {
            autoApproveLocal: true,
          },
        },
        auth: {
          mode: 'token',
          token: GATEWAY_TOKEN,
          trustedProxy: {
            userHeader: 'x-forwarded-user',
            allowLoopback: true,
            deviceAutoApprove: {
              enabled: true,
              scopes: [
                'operator.read',
                'operator.write',
                'operator.approvals',
                'operator.questions',
                'operator.admin',
              ],
            },
          },
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
    }

    const configContent = JSON.stringify(config, null, 2)
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), configContent, 'utf8')
    try {
      fs.writeFileSync('/home/node/.openclaw/openclaw.json', configContent, 'utf8')
      fs.writeFileSync('/root/.openclaw/openclaw.json', configContent, 'utf8')
    } catch {}

    log(`Config written to ${path.join(stateDir, 'openclaw.json')}`)

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

    // Run openclaw doctor --fix to sanitize config schema if needed
    try {
      log('Running openclaw doctor --fix...')
      const docRes = cp.spawnSync(
        executable.cmd,
        [...executable.args, 'doctor', '--fix', '--yes'],
        {
          cwd: workspaceDir,
          env: { ...process.env, PORT: OPENCLAW_PORT.toString() },
          encoding: 'utf8',
          timeout: 15000,
        },
      )
      if (docRes.stdout) log(`[doctor stdout] ${docRes.stdout.trim()}`)
    } catch (e) {
      log(`openclaw doctor error: ${e.message}`)
    }

    launchGateway(executable, workspaceDir)
  } catch (err) {
    gatewayStatus = `init_error: ${err.message}`
    log(`Initialization error: ${err.stack || err.message}`)
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

let approveInterval = null
function pollPort() {
  if (isOpenClawReady) return

  const req = http.get(`http://127.0.0.1:${OPENCLAW_PORT}/`, (res) => {
    log(`OpenClaw port ${OPENCLAW_PORT} responded with HTTP ${res.statusCode}! Marking READY.`)
    isOpenClawReady = true
    gatewayStatus = 'ready'

    // Automatically check and approve any pending device requests periodically
    if (!approveInterval) {
      approveInterval = setInterval(() => {
        approveAllPending()
      }, 2000)
    }
  })

  req.on('error', () => {
    // Retry in 1 second if still running
    if (gatewayStatus === 'starting') {
      setTimeout(pollPort, 1000)
    }
  })

  req.setTimeout(1000, () => req.destroy())
}
