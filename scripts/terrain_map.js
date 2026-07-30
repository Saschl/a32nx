// Downloads the SimBridge terrain database, converts it into the gauge-native
// terrain2.map (flat directory + grid-sorted payloads, a pure repack — see
// fbw-common/src/wasm/terronnd_rs/src/convert.rs) and places the converted
// file in the aircraft package where the terronnd gauge reads it from
// ./terrain/terrain2.map.
//
// Usage: node scripts/terrain_map.js <a32nx|a380x>

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const TERRAIN_MAP_CDN = 'https://cdn.flybywiresim.com/addons/simbridge/terrain-db-binaries/terrain.map';
const REPO_ROOT = path.join(__dirname, '..');
const CACHE_PATH = path.join(REPO_ROOT, 'cache', 'terrain.map');
const CACHE_V2_PATH = path.join(REPO_ROOT, 'cache', 'terrain2.map');
// anything below this is a failed/partial download (the real file is ~232 MB)
const MIN_PLAUSIBLE_BYTES = 50 * 1024 * 1024;

const TARGETS = {
  a32nx: path.join(REPO_ROOT, 'fbw-a32nx', 'out', 'flybywire-aircraft-a320-neo', 'terrain', 'terrain2.map'),
  a380x: path.join(REPO_ROOT, 'fbw-a380x', 'out', 'flybywire-aircraft-a380-842', 'terrain', 'terrain2.map'),
};

function validCache() {
  return fs.existsSync(CACHE_PATH) && fs.statSync(CACHE_PATH).size >= MIN_PLAUSIBLE_BYTES;
}

async function download() {
  console.log(`Downloading terrain map from ${TERRAIN_MAP_CDN}`);
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });

  const partPath = `${CACHE_PATH}.part`;
  const response = await fetch(TERRAIN_MAP_CDN);
  if (!response.ok || !response.body) {
    throw new Error(`terrain map download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partPath));

  const size = fs.statSync(partPath).size;
  if (size < MIN_PLAUSIBLE_BYTES) {
    fs.unlinkSync(partPath);
    throw new Error(`terrain map download looks truncated (${size} bytes)`);
  }
  fs.renameSync(partPath, CACHE_PATH);
  console.log(`Cached terrain map at ${CACHE_PATH} (${size} bytes)`);
}

function cargoConvert(args) {
  return spawnSync('cargo', ['run', '-q', '--release', '-p', 'terronnd', '--bin', 'terrain_map_convert', '--', ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

// v1 -> v2 conversion, skipped when cache/terrain2.map is newer than the
// download and passes the validity probe.
function ensureConverted() {
  if (fs.existsSync(CACHE_V2_PATH) && fs.statSync(CACHE_V2_PATH).mtimeMs >= fs.statSync(CACHE_PATH).mtimeMs) {
    const check = cargoConvert(['--check', CACHE_V2_PATH]);
    if (check.status === 0) {
      console.log(`Using converted terrain map at ${CACHE_V2_PATH}.`);
      return;
    }
  }
  console.log(`Converting ${CACHE_PATH} -> ${CACHE_V2_PATH}`);
  const convert = cargoConvert([CACHE_PATH, CACHE_V2_PATH]);
  if (convert.status !== 0) {
    throw new Error(`terrain map conversion failed (exit ${convert.status})`);
  }
}

async function execute() {
  const target = TARGETS[process.argv[2]];
  if (!target) {
    console.error('Usage: node scripts/terrain_map.js <a32nx|a380x>');
    process.exit(2);
  }

  if (!validCache()) {
    await download();
  } else {
    console.log(`Using cached terrain map at ${CACHE_PATH}. Delete it to force a re-download.`);
  }
  ensureConverted();

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
  try {
    fs.linkSync(CACHE_V2_PATH, target);
  } catch {
    // hard links fail across drives/filesystems — fall back to a copy
    fs.copyFileSync(CACHE_V2_PATH, target);
  }
  console.log(`Terrain map placed at ${target}`);
}

execute().catch((error) => {
  console.error(error);
  process.exit(1);
});
