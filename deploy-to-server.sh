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

    # parking_zagreb.geojson is no longer shipped: the viewer reads the OSM baseline from
    # /api/parking/osm (parking.osm_parking, versioned). A static copy only drifts.
    cp ${REPO_PATH}/data/final/parking_with_capacity.geojson ${WEB_ROOT}/data/final/parking_with_capacity.geojson
"
# LLM candidates are no longer served as a static file — the viewer reads them
# from /api/parking/aerial-candidates (ingested via pipeline/33_ingest_candidates.py).
# informal_parking.geojson is a regenerated pipeline artifact, rsynced from local:
echo "Syncing informal-parking layer…"
rsync -a data/final/informal_parking.geojson ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/data/final/informal_parking.geojson || true

# 2b. Diagnostic viewers (lane-widths + yolo-street-view) + provjera pages
echo "Deploying diagnostic viewers…"
${SSH_CMD} "
    mkdir -p ${WEB_ROOT}/lane-widths/data ${WEB_ROOT}/yolo-street-view/out ${WEB_ROOT}/provjera ${WEB_ROOT}/obrada
    # Status obrade is API-backed (reads /api/parking/coverage), so it works from a phone.
    # The status/ dashboard is a different thing and stays localhost-only.
    cp ${REPO_PATH}/obrada/obrada.html ${WEB_ROOT}/obrada/obrada.html
    cp ${REPO_PATH}/obrada/obrada.css  ${WEB_ROOT}/obrada/obrada.css
    cp ${REPO_PATH}/obrada/obrada.js   ${WEB_ROOT}/obrada/obrada.js
    cp ${REPO_PATH}/provjera/aerial.html ${WEB_ROOT}/provjera/aerial.html
    cp ${REPO_PATH}/provjera/aerial.css  ${WEB_ROOT}/provjera/aerial.css
    cp ${REPO_PATH}/provjera/aerial.js   ${WEB_ROOT}/provjera/aerial.js
    cp ${REPO_PATH}/lane-widths/viewer.html ${WEB_ROOT}/lane-widths/viewer.html
    cp ${REPO_PATH}/lane-widths/viewer.css  ${WEB_ROOT}/lane-widths/viewer.css
    cp ${REPO_PATH}/lane-widths/viewer.js   ${WEB_ROOT}/lane-widths/viewer.js
    cp ${REPO_PATH}/yolo-street-view/viewer.html ${WEB_ROOT}/yolo-street-view/viewer.html
    cp ${REPO_PATH}/yolo-street-view/viewer.css  ${WEB_ROOT}/yolo-street-view/viewer.css
    cp ${REPO_PATH}/yolo-street-view/viewer.js   ${WEB_ROOT}/yolo-street-view/viewer.js
    # yolo viewer loads images/<file>; point that at the street-view images synced to unos/
    ln -sfn ${WEB_ROOT}/unos/out/images ${WEB_ROOT}/yolo-street-view/images
"
# lane-widths/data is a local symlink to ../data/analysis; yolo analysis JSON is gitignored — rsync both
rsync -aL lane-widths/data/ ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/lane-widths/data/ || true
rsync -a yolo-street-view/out/yolo-analysis.json ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/yolo-street-view/out/yolo-analysis.json || true

# Composite PNGs power the crop preview in LLM-candidate popups (gitignored, ~75 MB)
echo "Syncing Phase 5 composites…"
rsync -a --include='*.png' --exclude='*' data/composites/cdof2022/ ${SERVER_USER}@${SERVER_HOST}:${WEB_ROOT}/data/composites/cdof2022/ || true

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

# 4. (The review UI's OSM layer also comes from /api/parking/osm now — nothing to sync.)

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
    # obrada.html: obrada.css and obrada.js
    sed -i -E 's/obrada\.css(\?v=[0-9]*)?/obrada.css?v=${CACHE_TS}/g' ${WEB_ROOT}/obrada/obrada.html
    sed -i -E 's/obrada\.js(\?v=[0-9]*)?/obrada.js?v=${CACHE_TS}/g' ${WEB_ROOT}/obrada/obrada.html
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
