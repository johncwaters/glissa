'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');

const WebSocket = require('ws');

const { dashboardClient } = require('../../tests/helpers/dashboard-ws');

const SHUTDOWN_TIMEOUT_MS = 15000;
const CLAUDE_CONFIG_DIRECTORY_NAME = 'claude-config';
const CREDENTIALS_COPY_NAME = '.credentials.json';

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function findFreeHighPort() {
  const reservationServer = http.createServer();
  await listen(reservationServer, 0);
  const address = reservationServer.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await closeServer(reservationServer);
  if (!Number.isInteger(port) || port < 1024) throw new Error('could not reserve a free high port');
  return port;
}

async function connectControl(port) {
  const client = await dashboardClient(port);
  const socket = new WebSocket(client.url('/control'), client.options);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function safeTextTail(value, maxCharacters = 2048) {
  return stripVTControlCharacters(String(value || ''))
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(-maxCharacters);
}

function credentialsCopyPath(tempDirectory) {
  return path.join(tempDirectory, CLAUDE_CONFIG_DIRECTORY_NAME, CREDENTIALS_COPY_NAME);
}

function makeClaudeConfig(tempDirectory, projectDirectories) {
  const claudeConfigDirectory = path.join(tempDirectory, CLAUDE_CONFIG_DIRECTORY_NAME);
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const accountStatePath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(credentialsPath)) throw new Error('Claude credentials are unavailable');
  if (!fs.existsSync(accountStatePath)) throw new Error('Claude account state is unavailable');
  const accountState = JSON.parse(fs.readFileSync(accountStatePath, 'utf8'));
  const trustedProjects = Object.fromEntries(
    projectDirectories.map((projectDirectory) => [projectDirectory, { hasTrustDialogAccepted: true }]),
  );
  fs.mkdirSync(claudeConfigDirectory);
  fs.copyFileSync(credentialsPath, credentialsCopyPath(tempDirectory));
  fs.chmodSync(credentialsCopyPath(tempDirectory), 0o600);
  fs.writeFileSync(
    path.join(claudeConfigDirectory, '.claude.json'),
    `${JSON.stringify({
      firstStartTime: accountState.firstStartTime,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: accountState.lastOnboardingVersion,
      oauthAccount: accountState.oauthAccount,
      projects: trustedProjects,
      userID: accountState.userID,
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return claudeConfigDirectory;
}

// One hung stopper must not hold the temp directory (and its copied credentials) open forever.
async function awaitBackendShutdown(backend) {
  if (!backend) return;
  const shutdown = backend.shutdown();
  const reaps = Array.isArray(shutdown?.reaps) ? shutdown.reaps : [];
  const stoppers = Array.isArray(shutdown?.stoppers)
    ? shutdown.stoppers.map((entry) => entry.promise)
    : [];
  let timeoutHandle = null;
  const shutdownDeadline = new Promise((resolve) => {
    timeoutHandle = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
  });
  await Promise.race([Promise.allSettled([...reaps, ...stoppers]), shutdownDeadline]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
}

// A PTY child that outlived the shutdown deadline can still be writing here, so one rm can hit ENOTEMPTY.
function removeHarnessTempDirectory(tempDirectory) {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`temp directory removal failed: ${error.message}`);
  }
  const leftoverCredentialsPath = credentialsCopyPath(tempDirectory);
  if (!fs.existsSync(leftoverCredentialsPath)) return;
  console.error(`WARNING: copied Claude credentials remain at ${leftoverCredentialsPath}, delete them by hand`);
  process.exitCode = 1;
}

module.exports = {
  awaitBackendShutdown,
  closeServer,
  connectControl,
  findFreeHighPort,
  listen,
  makeClaudeConfig,
  removeHarnessTempDirectory,
  safeTextTail,
};
