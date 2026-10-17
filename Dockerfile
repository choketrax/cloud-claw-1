# Use the official prebuilt OpenClaw slim image instead of compiling from source.
# This eliminates the ~19-minute build (git clone + pnpm install + pnpm build + pnpm ui:build)
# that was timing out on Cloudflare's free-tier runners.
FROM ghcr.io/openclaw/openclaw:slim

ENV NODE_ENV=production
ENV PORT=6658

ARG TIGRISFS_VERSION=1.2.1

USER root

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		fuse \
		ca-certificates \
		curl; \
	curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_amd64.deb" -o /tmp/tigrisfs.deb; \
	dpkg -i /tmp/tigrisfs.deb; \
	rm -f /tmp/tigrisfs.deb; \
	rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN install -m 755 /dev/stdin /entrypoint.sh <<'EOF'
#!/bin/bash

# Log everything to /tmp/openclaw.log as well as stdout
exec > >(tee -a /tmp/openclaw.log) 2>&1

echo "[$(date -u +%FT%TZ)] [INIT] Container entrypoint starting..."
echo "[INIT] User: $(id)"
echo "[INIT] PWD: $(pwd)"
echo "[INIT] Node version: $(node -v 2>&1 || echo 'node not found')"

MOUNT_POINT="/data"
export OPENCLAW_STATE_DIR="$MOUNT_POINT"
export OPENCLAW_WORKSPACE_DIR="$MOUNT_POINT/workspace"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export WORKER_URL="${WORKER_URL:-https://cloud-claw-final.dl-56e.workers.dev}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-cloud-claw}"

# Reset mountpoint if needed
mountpoint -q "$MOUNT_POINT" 2>/dev/null && fusermount -u "$MOUNT_POINT" 2>/dev/null || true
mkdir -p "$OPENCLAW_WORKSPACE_DIR" /home/node/.openclaw /root/.openclaw

# Handle S3/Tigris mount if credentials are provided, but never exit on failure
if [ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ] && [ -n "$S3_ACCESS_KEY_ID" ] && [ -n "$S3_SECRET_ACCESS_KEY" ]; then
	echo "[INFO] Mounting S3: ${S3_BUCKET} -> ${MOUNT_POINT}"
	export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
	export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
	export AWS_REGION="${S3_REGION:-auto}"
	export AWS_S3_PATH_STYLE="${S3_PATH_STYLE:-false}"

	if /usr/bin/tigrisfs --endpoint "$S3_ENDPOINT" ${TIGRISFS_ARGS:-} -f "${S3_BUCKET}${S3_PREFIX:+:$S3_PREFIX}" "$MOUNT_POINT" & then
		sleep 3
		if mountpoint -q "$MOUNT_POINT"; then
			echo "[OK] S3 mounted successfully"
		else
			echo "[WARN] S3 mount failed or FUSE unavailable in container, continuing with local directory mode"
		fi
	else
		echo "[WARN] tigrisfs invocation failed, continuing with local directory mode"
	fi
else
	echo "[INFO] S3 configuration not provided, using local directory mode"
fi

mkdir -p "$OPENCLAW_WORKSPACE_DIR"

cleanup() {
	echo "[INFO] Shutting down..."
	if [ -n "$OPENCLAW_PID" ]; then
		kill -TERM "$OPENCLAW_PID" 2>/dev/null
		wait "$OPENCLAW_PID" 2>/dev/null
	fi
	if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
		fusermount -u "$MOUNT_POINT" 2>/dev/null || true
	fi
	exit 0
}
trap cleanup SIGTERM SIGINT

# Write openclaw.json with expanded environment variables
cat > "$OPENCLAW_STATE_DIR/openclaw.json" << EOFCONFIG
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "port": 6658,
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "controlUi": {
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "allowedOrigins": [
        "https://cloud-claw-final.dl-56e.workers.dev",
        "http://localhost:6658",
        "http://127.0.0.1:6658",
        "http://container"
      ]
    }
  },
  "browser": {
    "enabled": true,
    "evaluateEnabled": true,
    "remoteCdpTimeoutMs": 120000,
    "remoteCdpHandshakeTimeoutMs": 60000,
    "attachOnly": true,
    "defaultProfile": "cloudflare",
    "profiles": {
      "cloudflare": {
        "cdpUrl": "${WORKER_URL}/cloudflare.browser/${OPENCLAW_GATEWAY_TOKEN}",
        "driver": "openclaw",
        "color": "#FF4500"
      }
    }
  }
}
EOFCONFIG

# Also sync config to standard locations
cp "$OPENCLAW_STATE_DIR/openclaw.json" /home/node/.openclaw/openclaw.json 2>/dev/null || true
cp "$OPENCLAW_STATE_DIR/openclaw.json" /root/.openclaw/openclaw.json 2>/dev/null || true
chmod -R 777 "$MOUNT_POINT" /tmp /home/node 2>/dev/null || true

echo "[INFO] Generated config:"
cat "$OPENCLAW_STATE_DIR/openclaw.json"

# Locate openclaw binary or script
echo "[INFO] Locating OpenClaw executable..."
OPENCLAW_CMD=""
if command -v openclaw >/dev/null 2>&1; then
    OPENCLAW_CMD="openclaw"
elif [ -f "/app/openclaw.mjs" ]; then
    OPENCLAW_CMD="node /app/openclaw.mjs"
elif [ -f "/app/dist/index.js" ]; then
    OPENCLAW_CMD="node /app/dist/index.js"
elif [ -f "/usr/local/bin/openclaw" ]; then
    OPENCLAW_CMD="/usr/local/bin/openclaw"
else
    CANDIDATE=$(find /app /usr /home -name "openclaw.mjs" -o -name "openclaw" 2>/dev/null | grep -E "bin|app" | head -n 1)
    if [ -n "$CANDIDATE" ]; then
        if [[ "$CANDIDATE" == *.mjs ]]; then
            OPENCLAW_CMD="node $CANDIDATE"
        else
            OPENCLAW_CMD="$CANDIDATE"
        fi
    fi
fi

if [ -z "$OPENCLAW_CMD" ]; then
    echo "[ERROR] OpenClaw executable could not be found anywhere!"
    echo "Directory listing of /app:"
    ls -la /app 2>&1 || true
    echo "Directory listing of /usr/local/bin:"
    ls -la /usr/local/bin 2>&1 || true
else
    echo "[INFO] Found OpenClaw command: $OPENCLAW_CMD"
fi

cd "$OPENCLAW_WORKSPACE_DIR"

if [ -n "$OPENCLAW_CMD" ]; then
    echo "[INFO] Starting OpenClaw Gateway on port 6658..."
    $OPENCLAW_CMD gateway --port 6658 --bind lan --token "$OPENCLAW_GATEWAY_TOKEN" --allow-unconfigured &
    OPENCLAW_PID=$!
    echo "[INFO] Process started with PID $OPENCLAW_PID"
    
    # Wait for process to exit or signal
    wait $OPENCLAW_PID 2>/dev/null
    EXIT_CODE=$?
    echo "[WARN] OpenClaw process exited with code $EXIT_CODE"
fi

echo "=================================================="
echo "CONTAINER FALLBACK DIAGNOSTIC SERVER RUNNING"
echo "Serving logs on port 6658"
echo "=================================================="

# Keep container alive and serve the exact log over HTTP on port 6658
node -e '
const http = require("http");
const fs = require("fs");
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  let log = "";
  try {
    log = fs.readFileSync("/tmp/openclaw.log", "utf8");
  } catch (e) {
    log = "Error reading /tmp/openclaw.log: " + e.message;
  }
  res.end(log);
});
server.listen(6658, "0.0.0.0", () => {
  console.log("Diagnostic HTTP server running on port 6658");
});
' || sleep 86400

sleep 86400
EOF

WORKDIR /data/workspace
EXPOSE 6658

ENTRYPOINT ["/entrypoint.sh"]
