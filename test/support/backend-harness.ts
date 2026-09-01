import type { Server } from 'node:http';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import WebSocket from 'ws';

import { dashboardClient } from '../../tests/helpers/dashboard-ws.ts';

const SHUTDOWN_TIMEOUT_MS = 15000;
const CLAUDE_CONFIG_DIRECTORY_NAME = 'claude-config';
const CREDENTIALS_COPY_NAME = '.credentials.json';

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off('listening', onListening);
      reject(error instanceof Error ? error : new Error(String(error)));
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

async function closeServer(server: Server | null | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function findFreeHighPort(): Promise<number> {
  const reservationServer = http.createServer();
  await listen(reservationServer, 0);
  const address = reservationServer.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await closeServer(reservationServer);
  if (port === null || !Number.isInteger(port) || port < 1024) throw new Error('could not reserve a free high port');
  return port;
}

async function connectControl(port: number): Promise<WebSocket> {
  const client = await dashboardClient(port);
  const socket = new WebSocket(client.url('/control'), client.options);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function safeTextTail(value: unknown, maxCharacters = 2048): string {
  return stripVTControlCharacters(String(value || ''))
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(-maxCharacters);
}

function credentialsCopyPath(tempDirectory: string): string {
  return path.join(tempDirectory, CLAUDE_CONFIG_DIRECTORY_NAME, CREDENTIALS_COPY_NAME);
}

function makeClaudeConfig(tempDirectory: string, projectDirectories: string[]): string {
  const claudeConfigDirectory = path.join(tempDirectory, CLAUDE_CONFIG_DIRECTORY_NAME);
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const accountStatePath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(credentialsPath)) throw new Error('Claude credentials are unavailable');
  if (!fs.existsSync(accountStatePath)) throw new Error('Claude account state is unavailable');
  const accountState = JSON.parse(fs.readFileSync(accountStatePath, 'utf8')) as Record<string, unknown>;
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

interface HarnessShutdown {
  reaps?: Promise<unknown>[];
  stoppers?: { promise: Promise<unknown> }[];
}

async function awaitBackendShutdown(backend: { shutdown: () => HarnessShutdown } | null | undefined): Promise<void> {
  if (!backend) return;
  const shutdown = backend.shutdown();
  const reaps = Array.isArray(shutdown?.reaps) ? shutdown.reaps : [];
  const stoppers = Array.isArray(shutdown?.stoppers)
    ? shutdown.stoppers.map((entry) => entry.promise)
    : [];
  let timeoutHandle: NodeJS.Timeout | null = null;
  const shutdownDeadline = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(), SHUTDOWN_TIMEOUT_MS);
  });
  await Promise.race([Promise.allSettled([...reaps, ...stoppers]), shutdownDeadline]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
}

function removeHarnessTempDirectory(tempDirectory: string): void {
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`temp directory removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const leftoverCredentialsPath = credentialsCopyPath(tempDirectory);
  if (!fs.existsSync(leftoverCredentialsPath)) return;
  console.error(`WARNING: copied Claude credentials remain at ${leftoverCredentialsPath}, delete them by hand`);
  process.exitCode = 1;
}

export {
  awaitBackendShutdown,
  closeServer,
  connectControl,
  findFreeHighPort,
  listen,
  makeClaudeConfig,
  removeHarnessTempDirectory,
  safeTextTail,
};
