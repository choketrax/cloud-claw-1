# Use the official prebuilt OpenClaw slim image instead of compiling from source.
# Build: unified-hub-v2
FROM ghcr.io/openclaw/openclaw:slim

ENV NODE_ENV=production
ENV PORT=6658

USER root

COPY entrypoint.js /entrypoint.js

WORKDIR /data/workspace
EXPOSE 6658

ENTRYPOINT ["node", "/entrypoint.js"]

