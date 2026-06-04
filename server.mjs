import { spawn } from 'node:child_process';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PID_FILE = path.join(__dirname, 'reader.pid');
const RUNNER = path.join(__dirname, 'run_hourly.sh');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HELPER_TIMEOUT_MS = Number(process.env.TELEGRAM_CHECK_TIMEOUT_MS || 15000);
const TELEGRAM_CACHE_MS = Number(process.env.TELEGRAM_CACHE_MS || 20000);

let telegramCache = null;

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

function getPythonBin() {
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

  const result = await runCommand(getPythonBin(), [path.join(__dirname, 'check_unread_inbox.py')], {
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

async function getStatus() {
  const [reader, telegram] = await Promise.all([getReaderStatus(), getTelegramStatus()]);
  return {
    reader,
    telegram,
    server: {
      running: true,
      host: HOST,
      port: PORT,
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

  process.kill(before.pid, 'SIGTERM');
  const reader = await waitForReaderState(false, 5000);
  return {
    ok: !reader.running,
    action: 'stop',
    reader,
    error: reader.running ? 'Reader is still running after SIGTERM' : null,
  };
}

async function restartReader() {
  const stopped = await stopReader();
  if (!stopped.ok) return { ...stopped, action: 'restart-stop-failed' };
  await new Promise((resolve) => setTimeout(resolve, 500));
  const started = await startReader();
  return { ...started, action: 'restart' };
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

  if (req.method === 'POST' && !isSameOriginRequest(req)) {
    sendJson(res, 403, { error: 'Forbidden origin' });
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
  console.log(`Read All status UI listening on http://${HOST}:${PORT}`);
});
