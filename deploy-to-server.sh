#!/bin/bash
# Deploys the zagreb-parkiralista viewer + published GeoJSON layers to the
# main server. Server pulls from github (no rsync), then we copy the static
# frontend + data files into the nginx web root.
#
# The cadastre-data/api endpoint /api/borders is deployed separately
# from cadastre-data — this script does not touch the API.
set -e

# Guard: only block on tracked file changes — untracked files don't affect
# the server since it pulls from git.
if ! git diff --quiet HEAD 2>/dev/null; then
    echo "ERROR: You have uncommitted changes to tracked files. These will NOT be deployed (deploy pulls from git)."
    echo "Commit and push first, then deploy."
    git status --short
    exit 1
fi

SERVER_USER="${DEPLOY_USER:-root}"
SERVER_HOST="${DEPLOY_HOST:-67.205.138.129}"
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
REPO_PATH="${DEPLOY_PATH:-/root/code/zagreb-parkiralista}"
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
    cp ${REPO_PATH}/favicon.svg ${WEB_ROOT}/favicon.svg

    cp ${REPO_PATH}/data/osm/parking_zagreb.geojson         ${WEB_ROOT}/data/osm/parking_zagreb.geojson
    cp ${REPO_PATH}/data/final/informal_parking.geojson     ${WEB_ROOT}/data/final/informal_parking.geojson || true
    cp ${REPO_PATH}/data/final/parking_with_capacity.geojson ${WEB_ROOT}/data/final/parking_with_capacity.geojson
    cp ${REPO_PATH}/data/candidates/llm_parking_candidates.geojson ${WEB_ROOT}/data/candidates/llm_parking_candidates.geojson || true
"

# 3. Deploy street-view review UI (tracked files only — everything under
# street-view/out/ is gitignored and handled in step 4 via local->server rsync).
echo "Deploying street-view review UI…"
${SSH_CMD} "
    mkdir -p ${WEB_ROOT}/unos/scripts/lib
    mkdir -p ${WEB_ROOT}/unos/out/images
    mkdir -p ${WEB_ROOT}/unos/data/osm

    cp ${REPO_PATH}/street-view/review.html ${WEB_ROOT}/unos/review.html
    cp ${REPO_PATH}/street-view/review.css  ${WEB_ROOT}/unos/review.css
    cp ${REPO_PATH}/street-view/review.js   ${WEB_ROOT}/unos/review.js

    cp ${REPO_PATH}/street-view/scripts/lib/*.mjs ${WEB_ROOT}/unos/scripts/lib/
"

# 4. Rsync gitignored data files (not in git, must be pushed from local)
echo "Syncing street-view OSM data…"
rsync -a street-view/data/osm/parking_zagreb.geojson ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/unos/data/osm/parking_zagreb.geojson

# Flat legacy image dir (older pipeline output) + per-area image dirs (newer
# pipeline output, e.g. street-view/out/donji-grad/images/). The API returns
# image_path values rooted at street-view/out/, so the layout on the server
# must mirror the local layout under ${WEB_ROOT}/unos/out/.
echo "Syncing street-view flat image dir (out/images)…"
rsync -a street-view/out/images/ ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/unos/out/images/

for dir in street-view/out/*/images; do
    [ -d "$dir" ] || continue
    area=$(basename "$(dirname "$dir")")
    echo "Syncing street-view per-area images: ${area}…"
    ${SSH_CMD} "mkdir -p ${WEB_ROOT}/unos/out/${area}/images"
    rsync -a "$dir/" ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/unos/out/${area}/images/
done

# 5. Cache-bust version params in HTML files with a deploy timestamp
CACHE_TS=$(date +%s)
echo "Cache-busting with timestamp ${CACHE_TS}…"
${SSH_CMD} "
    # review.html: review.css and review.js (may or may not have existing ?v=)
    sed -i -E 's/review\.css(\?v=[0-9]*)?/review.css?v=${CACHE_TS}/g' ${WEB_ROOT}/unos/review.html
    sed -i -E 's/review\.js(\?v=[0-9]*)?/review.js?v=${CACHE_TS}/g' ${WEB_ROOT}/unos/review.html
    # index.html: index.css and map.js (already have ?v=N)
    sed -i -E 's/index\.css(\?v=[0-9]*)?/index.css?v=${CACHE_TS}/g' ${WEB_ROOT}/index.html
    sed -i -E 's/map\.js(\?v=[0-9]*)?/map.js?v=${CACHE_TS}/g' ${WEB_ROOT}/index.html
"

echo "=== Deployment complete ==="
echo "Frontend: https://zagreb.lol/parkiralista"
echo "Review UI: https://zagreb.lol/parkiralista/unos/review.html"
echo ""
echo "NOTE: nginx must serve static files from ${WEB_ROOT} and proxy"
echo "/parkiralista/api/* to the cadastre-data API on :3001 if you want"
echo "the admin-borders dropdown to work in production."
echo ""
echo "Tile-popup previews (data/tiles_jpg/) are NOT deployed by this script."
echo "They're regenerable from the GeoTIFF tiles via 12_export_tile_jpegs.py."
echo "If you want them in production, rsync them separately:"
echo "  rsync -av --progress data/tiles_jpg/cdof2022/ ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/data/tiles_jpg/cdof2022/"
