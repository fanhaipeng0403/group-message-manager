#!/usr/bin/env bash
# Optional helper when docker.io is slow: pull via mirror, then tag as official names.
set -euo pipefail
MIRROR="${DOCKER_MIRROR:-docker.m.daocloud.io/library}"

docker pull "${MIRROR}/node:22-alpine"
docker tag "${MIRROR}/node:22-alpine" node:22-alpine
docker pull "${MIRROR}/nginx:1.27-alpine"
docker tag "${MIRROR}/nginx:1.27-alpine" nginx:1.27-alpine

echo "Tagged node:22-alpine and nginx:1.27-alpine"
