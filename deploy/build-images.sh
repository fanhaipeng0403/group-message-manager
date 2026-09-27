#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${VITE_API_URL:?Set VITE_API_URL}"
: "${VITE_WS_URL:?Set VITE_WS_URL}"
TAG="${GMM_IMAGE_TAG:-latest}"

docker build -f deploy/Dockerfile --target runtime-node -t "group-message-manager-node:${TAG}" .
docker build -f deploy/Dockerfile --target runtime-web \
  --build-arg "VITE_API_URL=${VITE_API_URL}" \
  --build-arg "VITE_WS_URL=${VITE_WS_URL}" \
  -t "group-message-manager-web:${TAG}" .

echo "Built group-message-manager-node:${TAG} and group-message-manager-web:${TAG}"
