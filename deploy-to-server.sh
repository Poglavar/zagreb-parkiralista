#!/bin/bash
# Deploys the zagreb-parkiralista viewer + published GeoJSON layers to the
# main server. Server pulls from github (no rsync), then we copy the static
# frontend + data files into the nginx web root.
#
# The cadastre-data/api endpoint /api/admin/borders is deployed separately
# from cadastre-data — this script does not touch the API.
set -e

# Guard: pulling from git means uncommitted changes won't ship
if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "ERROR: You have uncommitted changes. These will NOT be deployed (deploy pulls from git)."
    echo "Commit and push first, then deploy."
    git status --short
    exit 1
fi

SERVER_USER="${DEPLOY_USER:-root}"
SERVER_HOST="${DEPLOY_HOST:-67.205.138.129}"
SSH_KEY="${DEPLOY_SSH_KEY:-~/.ssh/id_ed25519}"
REPO_PATH="${DEPLOY_PATH:-~/code/zagreb-parkiralista}"
WEB_ROOT="${DEPLOY_WEB_ROOT:-/var/www/zagreb.lol/parkiralista}"
GIT_REMOTE="${DEPLOY_GIT_REMOTE:-https://github.com/Poglavar/zagreb-parkiralista.git}"

SSH_CMD="ssh ${SERVER_USER}@${SERVER_HOST} -i ${SSH_KEY}"

echo "=== Deploying zagreb-parkiralista to ${SERVER_HOST} ==="

# 1. Clone or pull the repo
echo "Pulling latest code…"
${SSH_CMD} "
    if [ ! -d ${REPO_PATH} ]; then
        git clone ${GIT_REMOTE} ${REPO_PATH}
    fi
    cd ${REPO_PATH} && git pull
"

# 2. Copy viewer + data layers to web root
echo "Deploying frontend + data…"
${SSH_CMD} "
    mkdir -p ${WEB_ROOT}/js
    mkdir -p ${WEB_ROOT}/data/osm
    mkdir -p ${WEB_ROOT}/data/final
    mkdir -p ${WEB_ROOT}/data/candidates

    cp ${REPO_PATH}/index.html ${WEB_ROOT}/index.html
    cp ${REPO_PATH}/index.css  ${WEB_ROOT}/index.css
    cp ${REPO_PATH}/js/map.js  ${WEB_ROOT}/js/map.js

    cp ${REPO_PATH}/data/osm/parking_zagreb.geojson         ${WEB_ROOT}/data/osm/parking_zagreb.geojson
    cp ${REPO_PATH}/data/final/informal_parking.geojson     ${WEB_ROOT}/data/final/informal_parking.geojson
    cp ${REPO_PATH}/data/final/parking_with_capacity.geojson ${WEB_ROOT}/data/final/parking_with_capacity.geojson
    cp ${REPO_PATH}/data/candidates/llm_parking_candidates.geojson ${WEB_ROOT}/data/candidates/llm_parking_candidates.geojson || true
    cp ${REPO_PATH}/data/candidates/vehicles.geojson        ${WEB_ROOT}/data/candidates/vehicles.geojson || true
"

echo "=== Deployment complete ==="
echo "Frontend: https://zagreb.lol/parkiralista"
echo ""
echo "NOTE: nginx must serve static files from ${WEB_ROOT} and proxy"
echo "/parkiralista/api/* to the cadastre-data API on :3001 if you want"
echo "the admin-borders dropdown to work in production."
echo ""
echo "Tile-popup previews (data/tiles_jpg/) are NOT deployed by this script."
echo "They're regenerable from the GeoTIFF tiles via 12_export_tile_jpegs.py."
echo "If you want them in production, rsync them separately:"
echo "  rsync -av --progress data/tiles_jpg/cdof2022/ ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/data/tiles_jpg/cdof2022/"
