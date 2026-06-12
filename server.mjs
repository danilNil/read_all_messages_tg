import { spawn } from 'node:child_process';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PID_FILE = process.env.READER_PID_FILE || path.join(__dirname, 'reader.pid');
const READER_STATUS_FILE = process.env.READER_STATUS_FILE || path.join(__dirname, 'reader_status.json');
const RUNNER = process.env.READER_RUNNER || path.join(__dirname, 'run_hourly.sh');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const TELEGRAM_HELPER = process.env.TELEGRAM_HELPER || path.join(__dirname, 'check_unread_inbox.py');
const HELPER_TIMEOUT_MS = Number(process.env.TELEGRAM_CHECK_TIMEOUT_MS || 30000);
const TELEGRAM_CACHE_MS = Number(process.env.TELEGRAM_CACHE_MS || 20000);
const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, '.env');
const VK_API_BASE_URL = process.env.VK_API_BASE_URL || 'https://api.vk.com/method';
const VK_API_VERSION = process.env.VK_API_VERSION || '5.199';
const VK_CHECK_TIMEOUT_MS = Number(process.env.VK_CHECK_TIMEOUT_MS || 30000);
const VK_CACHE_MS = Number(process.env.VK_CACHE_MS || 20000);
const VK_UNREAD_COUNT = Math.min(Number(process.env.VK_UNREAD_COUNT || 50), 200);

let telegramCache = null;
let vkCache = null;
let vkSessionCache = null;
let serverPort = PORT;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function parseDotEnv(raw) {
  const values = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return values;
}

async function readEnvValues() {
  try {
    return parseDotEnv(await fs.readFile(ENV_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function getConfigValue(name) {
  const fileEnv = await readEnvValues();
  return process.env[name] || fileEnv[name] || '';
}

function quoteEnvValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function updateEnvValues(updates) {
  let raw = '';
  try {
    raw = await fs.readFile(ENV_FILE, 'utf8');
  } catch {
    raw = '';
  }

  const lines = raw ? raw.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !pending.has(match[1])) return line;

    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${quoteEnvValue(value)}`;
  });

  if (nextLines.length && nextLines[nextLines.length - 1] === '') {
    nextLines.pop();
  }

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${quoteEnvValue(value)}`);
  }

  await fs.writeFile(ENV_FILE, `${nextLines.join('\n')}\n`, { mode: 0o600 });
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
      if (Buffer.byteLength(body) > limitBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

async function readPid() {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf8');
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getReaderStatus() {
  const pid = await readPid();
  const running = isProcessRunning(pid);

  return {
    running,
    pid: running ? pid : null,
    source: existsSync(PID_FILE) ? 'reader.pid' : null,
    stalePid: Boolean(pid && !running),
  };
}

async function getArchiveStatus() {
  try {
    const payload = JSON.parse(await fs.readFile(READER_STATUS_FILE, 'utf8'));
    return {
      lastReadAt: payload.archiveLastReadAt || null,
      processedDialogCount: Number(payload.archiveProcessedDialogCount || 0),
      foundDialogCount: Number(payload.archiveFoundDialogCount || payload.archiveProcessedDialogCount || 0),
      error: payload.archiveError || null,
      source: 'reader_status.json',
    };
  } catch {
    return {
      lastReadAt: null,
      processedDialogCount: 0,
      foundDialogCount: 0,
      error: null,
      source: null,
    };
  }
}

function getPythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;

  const venvPython = path.join(__dirname, 'venv', 'bin', 'python');
  return existsSync(venvPython) ? venvPython : 'python3';
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          resolve({ code: null, stdout, stderr, timedOut: true });
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

async function getTelegramStatus() {
  const now = Date.now();
  if (telegramCache && now - telegramCache.cachedAt < TELEGRAM_CACHE_MS) {
    return { ...telegramCache.value, cached: true };
  }

  const result = await runCommand(getPythonBin(), [TELEGRAM_HELPER], {
    timeoutMs: HELPER_TIMEOUT_MS,
  });

  let value;
  if (result.timedOut) {
    value = {
      hasUnreadInbox: false,
      unreadDialogCount: 0,
      checkedAt: new Date().toISOString(),
      error: `Telegram check timed out after ${HELPER_TIMEOUT_MS}ms`,
    };
  } else {
    try {
      value = JSON.parse(result.stdout.trim());
    } catch {
      value = {
        hasUnreadInbox: false,
        unreadDialogCount: 0,
        checkedAt: new Date().toISOString(),
        error: result.stderr.trim() || result.stdout.trim() || 'Telegram check failed',
      };
    }
  }

  telegramCache = { cachedAt: now, value };
  return { ...value, cached: false };
}

function normalizeVkError(payload) {
  const error = payload?.error;
  if (!error) return null;

  const code = error.error_code ? `VK ${error.error_code}` : 'VK error';
  return `${code}: ${error.error_msg || 'request failed'}`;
}

async function callVkApi(method, params, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VK_CHECK_TIMEOUT_MS);

  try {
    const searchParams = new URLSearchParams({
      ...params,
      v: VK_API_VERSION,
      access_token: token,
    });
    const response = await fetch(`${VK_API_BASE_URL}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: searchParams,
      signal: controller.signal,
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(text || `VK returned HTTP ${response.status}`);
    }

    const vkError = normalizeVkError(payload);
    if (vkError) throw new Error(vkError);
    if (!response.ok) throw new Error(`VK returned HTTP ${response.status}`);

    return payload.response;
  } finally {
    clearTimeout(timeout);
  }
}

function getConversationTitle(item) {
  const peer = item?.conversation?.peer || {};
  if (peer.local_id) return `${peer.type || 'peer'} ${peer.local_id}`;
  if (peer.id) return `${peer.type || 'peer'} ${peer.id}`;
  return peer.type || 'conversation';
}

async function validateVkToken(token) {
  const response = await callVkApi(
    'messages.getConversations',
    { filter: 'unread', count: '1' },
    token,
  );

  return {
    valid: true,
    configured: true,
    checkedAt: new Date().toISOString(),
    error: null,
    unreadDialogCount: Number(response?.count || 0),
  };
}

async function getVkSessionStatus({ force = false, token = null } = {}) {
  const now = Date.now();
  const tokenToCheck = token || (await getConfigValue('VK_ACCESS_TOKEN'));

  if (!tokenToCheck) {
    return {
      valid: false,
      configured: false,
      checkedAt: new Date().toISOString(),
      error: 'VK token is not configured',
    };
  }

  if (!force && !token && vkSessionCache && now - vkSessionCache.cachedAt < VK_CACHE_MS) {
    return { ...vkSessionCache.value, cached: true };
  }

  let value;
  try {
    value = await validateVkToken(tokenToCheck);
  } catch (error) {
    value = {
      valid: false,
      configured: true,
      checkedAt: new Date().toISOString(),
      error: error.name === 'AbortError'
        ? `VK check timed out after ${VK_CHECK_TIMEOUT_MS}ms`
        : error.message,
    };
  }

  if (!token) {
    vkSessionCache = { cachedAt: now, value };
  }
  return { ...value, cached: false };
}

async function getVkStatus() {
  const now = Date.now();
  if (vkCache && now - vkCache.cachedAt < VK_CACHE_MS) {
    return { ...vkCache.value, cached: true };
  }

  const token = await getConfigValue('VK_ACCESS_TOKEN');
  let value;

  if (!token) {
    value = {
      hasUnreadInbox: false,
      unreadDialogCount: 0,
      unreadDialogs: [],
      checkedAt: new Date().toISOString(),
      error: 'VK token is not configured',
    };
  } else {
    try {
      const response = await callVkApi(
        'messages.getConversations',
        { filter: 'unread', count: String(VK_UNREAD_COUNT) },
        token,
      );
      const items = Array.isArray(response?.items) ? response.items : [];

      value = {
        hasUnreadInbox: Number(response?.count || 0) > 0 || items.length > 0,
        unreadDialogCount: Number(response?.count || items.length || 0),
        checkedAt: new Date().toISOString(),
        error: null,
        unreadDialogs: items.slice(0, 20).map((item) => ({
          peerId: item?.conversation?.peer?.id || null,
          title: getConversationTitle(item),
          unreadCount: Number(item?.conversation?.unread_count || 0),
          type: item?.conversation?.peer?.type || null,
        })),
      };
    } catch (error) {
      value = {
        hasUnreadInbox: false,
        unreadDialogCount: 0,
        unreadDialogs: [],
        checkedAt: new Date().toISOString(),
        error: error.name === 'AbortError'
          ? `VK check timed out after ${VK_CHECK_TIMEOUT_MS}ms`
          : error.message,
      };
    }
  }

  vkCache = { cachedAt: now, value };
  return { ...value, cached: false };
}

async function getStatus() {
  const [reader, archive, telegram, vk, vkSession] = await Promise.all([
    getReaderStatus(),
    getArchiveStatus(),
    getTelegramStatus(),
    getVkStatus(),
    getVkSessionStatus(),
  ]);
  return {
    reader,
    archive,
    telegram,
    vk,
    vkSession,
    server: {
      running: true,
      host: HOST,
      port: serverPort,
      checkedAt: new Date().toISOString(),
    },
  };
}

async function waitForReaderState(expectedRunning, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getReaderStatus();
    if (status.running === expectedRunning) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return getReaderStatus();
}

async function getChildPids(pid) {
  const result = await runCommand('pgrep', ['-P', String(pid)], { timeoutMs: 1000 });
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function killProcessTree(pid, signal) {
  const childPids = await getChildPids(pid);

  for (const childPid of childPids) {
    if (isProcessRunning(childPid)) {
      try {
        process.kill(childPid, signal);
      } catch {
        // Process may exit between discovery and signal delivery.
      }
    }
  }

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may already be gone.
    }
  }
}

async function startReader() {
  const before = await getReaderStatus();
  if (before.running) return { ok: true, action: 'already-running', reader: before };

  if (before.stalePid) {
    await fs.rm(PID_FILE, { force: true });
  }

  const result = await runCommand(RUNNER, ['background'], { timeoutMs: 5000 });
  const reader = await waitForReaderState(true, 5000);
  return {
    ok: reader.running,
    action: 'start',
    reader,
    output: result.stdout.trim(),
    error: reader.running ? null : result.stderr.trim() || 'Reader did not start',
  };
}

async function stopReader() {
  const before = await getReaderStatus();
  if (!before.running) {
    if (before.stalePid) await fs.rm(PID_FILE, { force: true });
    return { ok: true, action: 'already-stopped', reader: await getReaderStatus() };
  }

  await killProcessTree(before.pid, 'SIGTERM');
  let reader = await waitForReaderState(false, 8000);

  if (reader.running) {
    await killProcessTree(before.pid, 'SIGKILL');
    reader = await waitForReaderState(false, 3000);
  }

  if (!reader.running) {
    await fs.rm(PID_FILE, { force: true });
    reader = await getReaderStatus();
  }

  return {
    ok: !reader.running,
    action: 'stop',
    reader,
    error: reader.running ? 'Reader is still running after SIGTERM and SIGKILL' : null,
  };
}

async function restartReader() {
  const stopped = await stopReader();
  if (!stopped.ok) return { ...stopped, action: 'restart-stop-failed' };
  await new Promise((resolve) => setTimeout(resolve, 500));
  const started = await startReader();
  return { ...started, action: 'restart' };
}

async function saveVkToken(req, res) {
  const body = await readJsonBody(req);
  const token = String(body.token || '').trim();

  if (!token) {
    sendJson(res, 400, { ok: false, error: 'VK token is required' });
    return;
  }

  const session = await getVkSessionStatus({ force: true, token });
  if (!session.valid) {
    sendJson(res, 400, { ok: false, session, error: session.error || 'VK token is invalid' });
    return;
  }

  await updateEnvValues({
    VK_ACCESS_TOKEN: token,
    VK_API_VERSION,
  });
  process.env.VK_ACCESS_TOKEN = token;
  vkCache = null;
  vkSessionCache = null;

  sendJson(res, 200, {
    ok: true,
    session: await getVkSessionStatus({ force: true }),
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
  }[ext] || 'application/octet-stream';

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => res.end());
  res.writeHead(200, { 'Content-Type': contentType });
  stream.pipe(res);
}

async function handleApi(req, res) {
  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, { ok: true, checkedAt: new Date().toISOString() });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/status') {
    sendJson(res, 200, await getStatus());
    return;
  }

  if (req.method === 'GET' && req.url === '/api/vk/session') {
    sendJson(res, 200, await getVkSessionStatus());
    return;
  }

  if (req.method === 'POST' && !isSameOriginRequest(req)) {
    sendJson(res, 403, { error: 'Forbidden origin' });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/vk/session/check') {
    vkSessionCache = null;
    sendJson(res, 200, await getVkSessionStatus({ force: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/vk/token') {
    await saveVkToken(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/reader/start') {
    sendJson(res, 200, await startReader());
    return;
  }

  if (req.method === 'POST' && req.url === '/api/reader/stop') {
    sendJson(res, 200, await stopReader());
    return;
  }

  if (req.method === 'POST' && req.url === '/api/reader/restart') {
    sendJson(res, 200, await restartReader());
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.headers.host;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  serverPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`Read All status UI listening on http://${HOST}:${serverPort}`);
});
