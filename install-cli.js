#!/usr/bin/env node
'use strict';

// Instala el binario de aisecbox-cli para el runner actual desde
// aisecbox.com/downloads (o desde un mirror con el mismo layout).
//
// Lo usa la composite action de action.yml. No necesita API key: el binario
// se descarga de una URL pública y se verifica con el checksum que publica
// GoReleaser en artifacts.json.

const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = (process.env.AISECBOX_BASE_URL || 'https://aisecbox.com/downloads').replace(/\/+$/, '');
const BIN_DIR = process.env.AISECBOX_BIN_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'aisecbox-cli-bin');
const OUT_FILE = process.env.GITHUB_OUTPUT;
const PATH_FILE = process.env.GITHUB_PATH;

const GOOS = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
const GOARCH = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function setOutput(name, value) {
  if (OUT_FILE) fs.appendFileSync(OUT_FILE, `${name}=${value}\n`);
}

async function fetchWithTimeout(url, asBuffer) {
  if (typeof fetch !== 'function') {
    throw new Error('Node 18+ is required to run this action (global fetch is missing).');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
  }
  return asBuffer ? Buffer.from(await response.arrayBuffer()) : response.json();
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const isZip = archive.toLowerCase().endsWith('.zip');
  try {
    execFileSync('tar', isZip ? ['-xf', archive, '-C', dest] : ['-xzf', archive, '-C', dest], {
      stdio: 'inherit',
    });
  } catch (error) {
    // En Windows el runner trae bsdtar, que entiende zip. Si fallara, PowerShell
    // es el fallback.
    if (isZip && process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`],
        { stdio: 'inherit' },
      );
    } else {
      throw error;
    }
  }
}

async function main() {
  if (!GOOS || !GOARCH) {
    fail(`Unsupported runner platform: ${process.platform}/${process.arch}`);
  }
  if (!/^https:\/\//i.test(BASE_URL)) {
    fail(`AISECBOX_BASE_URL must use https: ${BASE_URL}`);
  }

  const artifacts = await fetchWithTimeout(`${BASE_URL}/artifacts.json`, false);
  if (!Array.isArray(artifacts)) {
    fail('artifacts.json is not an array');
  }

  const match = (artifact) => artifact.goos === GOOS && artifact.goarch === GOARCH;
  const artifact =
    artifacts.find((a) => a.type === 'Archive' && match(a)) ||
    artifacts.find((a) => a.type === 'Binary' && match(a));

  if (!artifact) {
    fail(`No aisecbox-cli artifact published for ${GOOS}/${GOARCH}.`);
  }

  const url = `${BASE_URL}/${artifact.name}`;
  const payload = await fetchWithTimeout(url, true);

  const checksum = artifact.extra && artifact.extra.Checksum;
  if (checksum) {
    const expected = String(checksum).replace(/^sha256:/i, '').toLowerCase();
    const actual = createHash('sha256').update(payload).digest('hex');
    if (actual !== expected) {
      fail(`Checksum mismatch for ${artifact.name}: expected ${expected}, got ${actual}`);
    }
  } else {
    console.log(`::warning::No checksum published for ${artifact.name}; skipping integrity check.`);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const binaryName = GOOS === 'windows' ? 'aisecbox-cli.exe' : 'aisecbox-cli';
  const binaryPath = path.join(BIN_DIR, binaryName);

  if (artifact.type === 'Archive') {
    const archivePath = path.join(BIN_DIR, artifact.name);
    fs.writeFileSync(archivePath, payload);
    extract(archivePath, BIN_DIR);
    fs.rmSync(archivePath, { force: true });
  } else {
    fs.writeFileSync(binaryPath, payload);
  }

  if (!fs.existsSync(binaryPath)) {
    fail(`The downloaded artifact ${artifact.name} does not contain ${binaryName}.`);
  }
  if (GOOS !== 'windows') fs.chmodSync(binaryPath, 0o755);

  // La release publicada puede ser anterior a `patch apply`. Fallar aquí da un
  // mensaje claro en lugar de un "unknown command" a mitad del workflow.
  try {
    execFileSync(binaryPath, ['patch', '--help'], { stdio: 'ignore' });
  } catch {
    fail(
      `The installed aisecbox-cli (${artifact.name}) does not include 'patch apply'. ` +
        'Publish a release with the patch feature or build the CLI from source.',
    );
  }

  // Git Bash (Windows) maneja mejor las rutas con '/'; el binario se ejecuta
  // con la ruta nativa desde Node, pero los outputs van normalizados.
  const posix = (value) => value.replace(/\\/g, '/');
  setOutput('bin', posix(binaryPath));
  if (PATH_FILE) {
    fs.appendFileSync(PATH_FILE, `${posix(BIN_DIR)}\n`);
  }
  console.log(`Installed aisecbox-cli from ${url}`);
}

main().catch((error) => fail(error.message));
