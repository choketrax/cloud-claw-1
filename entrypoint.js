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

// 1. Start HTTP Server immediately so Cloudflare Containers probe succeeds instantly
const server = http.createServer((req, res) => {
  // Always answer /health and /healthz with 200
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('OK')
  }

  // Diagnostic endpoints
  if (req.url === '/_logs' || req.url === '/_status') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(`Status: ${gatewayStatus}\n\n=== RECENT LOGS ===\n` + logs.join('\n'))
  }

  if (isOpenClawReady) {
    const cleanHeaders = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (lower.startsWith('x-forwarded-') || lower.startsWith('cf-') || lower === 'host') {
        continue
      }
      cleanHeaders[key] = value
    }
    cleanHeaders['host'] = `127.0.0.1:${OPENCLAW_PORT}`

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: OPENCLAW_PORT,
        path: req.url,
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
  if (!isOpenClawReady) {
    log(`WS upgrade requested while OpenClaw not ready (status: ${gatewayStatus})`)
    socket.destroy()
    return
  }

  const cleanHeaders = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (lower.startsWith('x-forwarded-') || lower.startsWith('cf-') || lower === 'host') {
      continue
    }
    cleanHeaders[key] = value
  }
  cleanHeaders['host'] = `127.0.0.1:${OPENCLAW_PORT}`

  const targetSocket = net.connect(OPENCLAW_PORT, '127.0.0.1', () => {
    let rawHeaders = `${req.method} ${req.url} HTTP/1.1\r\n`
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
        trustedProxies: [
          '127.0.0.1',
          '::1',
          '::ffff:127.0.0.1',
          '10.0.0.0/8',
          '172.16.0.0/12',
          '192.168.0.0/16',
        ],
        auth: {
          mode: 'token',
          token: GATEWAY_TOKEN,
        },
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true,
          allowedOrigins: [
            WORKER_URL,
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
    const executable = findExecutable()
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

    // Ensure trustedProxies is definitely in openclaw.json
    try {
      const cfgPath = path.join(stateDir, 'openclaw.json')
      const loaded = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      if (!loaded.gateway) loaded.gateway = {}
      loaded.gateway.trustedProxies = [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
      ]
      fs.writeFileSync(cfgPath, JSON.stringify(loaded, null, 2), 'utf8')
      try {
        fs.writeFileSync(
          '/home/node/.openclaw/openclaw.json',
          JSON.stringify(loaded, null, 2),
          'utf8',
        )
      } catch {}
      log(`Verified trustedProxies in ${cfgPath}`)
    } catch (e) {
      log(`Error ensuring trustedProxies in openclaw.json: ${e.message}`)
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
    }
  })

  openclawProcess.on('exit', (code, signal) => {
    isOpenClawReady = false
    gatewayStatus = `exited (code ${code}, signal ${signal})`
    log(`OpenClaw process exited with code ${code}, signal ${signal}`)
  })

  openclawProcess.on('error', (err) => {
    isOpenClawReady = false
    gatewayStatus = `spawn_error: ${err.message}`
    log(`OpenClaw spawn error: ${err.message}`)
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
