# Cloud Claw — Cloudflare Container Dockerfile
#
# CHANGED: Replaced the ~19-minute local OpenClaw compile (FROM node:22-bookworm AS openclaw-build
# → git clone → pnpm install → pnpm build → pnpm ui:build) with the official prebuilt slim image.
# The official GHCR image is the recommended route when you don't want to build locally.
#
# Architecture:
#   ghcr.io/openclaw/openclaw:slim  ← official prebuilt (~no compile time)
#   + TigrisFS FUSE mount layer     ← S3-compatible workspace persistence
#   + /entrypoint.sh                ← Cloud Claw startup/config orchestration
#   + port 6658                     ← Cloudflare Container compatible

FROM ghcr.io/openclaw/openclaw:slim

ENV NODE_ENV=production
ENV PORT=6658

ARG TIGRISFS_VERSION=1.2.1

# Install TigrisFS (FUSE-based S3 mount) and runtime dependencies
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

# Cloud Claw entrypoint: mounts TigrisFS workspace, seeds config, starts the gateway
RUN install -m 755 /dev/stdin /entrypoint.sh <<'EOF'
#!/bin/bash
set -e

MOUNT_POINT="/data"

export OPENCLAW_STATE_DIR="$MOUNT_POINT"
export OPENCLAW_WORKSPACE_DIR="$MOUNT_POINT/workspace"

setup_workspace() {
	mkdir -p "$OPENCLAW_WORKSPACE_DIR"
}

reset_mountpoint() {
	mountpoint -q "$MOUNT_POINT" 2>/dev/null && fusermount -u "$MOUNT_POINT" 2>/dev/null || true
	rm -rf "$MOUNT_POINT"
	mkdir -p "$MOUNT_POINT"
}

reset_mountpoint

if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_BUCKET" ] || [ -z "$S3_ACCESS_KEY_ID" ] || [ -z "$S3_SECRET_ACCESS_KEY" ]; then
	echo "[WARN] S3 configuration incomplete, using local directory mode"
else
	echo "[INFO] Mounting S3: ${S3_BUCKET} -> ${MOUNT_POINT}"

	export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID}"
	export AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY}"
	export AWS_ENDPOINT_URL_S3="${S3_ENDPOINT}"
	export AWS_REGION="${S3_REGION:-auto}"
	export AWS_S3_PATH_STYLE="${S3_PATH_STYLE:-false}"

	/usr/bin/tigrisfs --endpoint "$S3_ENDPOINT" ${TIGRISFS_ARGS:-} -f "${S3_BUCKET}${S3_PREFIX:+:$S3_PREFIX}" "$MOUNT_POINT" &
	sleep 3

	if ! mountpoint -q "$MOUNT_POINT"; then
		echo "[ERROR] S3 mount failed"
		exit 1
	fi
	echo "[OK] S3 mounted successfully"
fi

setup_workspace

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

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
	echo "[INFO] Using Gateway Token from environment variable"
else
	echo "[WARN] OPENCLAW_GATEWAY_TOKEN not set, will be auto-generated"
fi

if [ ! -f "$OPENCLAW_STATE_DIR/openclaw.json" ]; then
	cat > "$OPENCLAW_STATE_DIR/openclaw.json" << 'EOFCONFIG'
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "port": 6658,
    "auth": {
      "mode": "token"
    },
    "controlUi": {
      "allowInsecureAuth": true
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
        "driver": "clawd",
        "color": "#FF4500"
      }
    }
  }
}
EOFCONFIG
	echo "[INFO] Default config file created (local mode + allowInsecureAuth)"
fi

echo "[INFO] Starting OpenClaw Gateway..."
echo "[INFO] Visit Web UI for initial setup on first use"
cd "$OPENCLAW_WORKSPACE_DIR"

openclaw gateway --port 6658 --bind lan --allow-unconfigured &
OPENCLAW_PID=$!
wait $OPENCLAW_PID
EOF

WORKDIR /data/workspace
EXPOSE 6658

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
	CMD curl -f http://localhost:6658/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
