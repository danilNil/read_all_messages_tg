import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');
const SERVER = path.join(ROOT_DIR, 'server.mjs');

async function createFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'read-all-e2e-'));
  const pidFile = path.join(dir, 'reader.pid');
  const readerStatusFile = path.join(dir, 'reader_status.json');
  const envFile = path.join(dir, '.env');
  const helperState = path.join(dir, 'telegram.json');
  const helper = path.join(dir, 'fake-helper.mjs');
  const runner = path.join(dir, 'fake-runner.sh');

  await writeFile(
    helper,
    [
      "import { readFileSync } from 'node:fs';",
      "const payload = JSON.parse(readFileSync(process.env.FAKE_TELEGRAM_JSON, 'utf8'));",
      'console.log(JSON.stringify(payload));',
      '',
    ].join('\n'),
  );

  await writeFile(
    runner,
    [
      '#!/bin/bash',
      'set -e',
      'if [[ "$1" == "background" ]]; then',
      '  sleep 300 &',
      '  echo $! > "$READER_PID_FILE"',
      '  echo "Started fake reader. PID: $!"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(runner, 0o755);

  await writeTelegramState(helperState, {
    hasUnreadInbox: false,
    unreadDialogCount: 0,
    unreadDialogs: [],
    checkedAt: new Date().toISOString(),
    error: null,
  });

  t.after(async () => {
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
    } catch {
      // The fake reader may already be stopped.
    }
    await rm(dir, { recursive: true, force: true });
  });

  return { dir, pidFile, readerStatusFile, envFile, helperState, helper, runner };
}

async function writeTelegramState(filePath, payload) {
  await writeFile(filePath, JSON.stringify(payload));
}

function startServer(t, fixture, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      PYTHON_BIN: process.execPath,
      TELEGRAM_HELPER: fixture.helper,
      FAKE_TELEGRAM_JSON: fixture.helperState,
      READER_PID_FILE: fixture.pidFile,
      READER_STATUS_FILE: fixture.readerStatusFile,
      READER_RUNNER: fixture.runner,
      TELEGRAM_CACHE_MS: '0',
      TELEGRAM_CHECK_TIMEOUT_MS: '5000',
      ENV_FILE: fixture.envFile,
      VK_CACHE_MS: '0',
      VK_CHECK_TIMEOUT_MS: '5000',
      READER_AUTO_START: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Server did not start. stderr: ${stderr}`));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;

      clearTimeout(timer);
      resolve({ child, baseUrl: `http://127.0.0.1:${match[1]}` });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before ready with code ${code}. stderr: ${stderr}`));
    });
  });
}

function startFakeVkApi(t, handler) {
  const server = createServer((req, res) => {
    handler(req, res);
  });

  t.after(() => {
    server.close();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function readFormBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  return new URLSearchParams(body);
}

async function getJson(baseUrl, pathName) {
  const response = await fetch(`${baseUrl}${pathName}`);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function postJson(baseUrl, pathName, init = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    ...init,
  });
  const body = await response.json();
  return { response, body };
}

test('status shows reader stopped and no unread inbox when helper reports clean inbox', async (t) => {
  const fixture = await createFixture(t);
  const { baseUrl } = await startServer(t, fixture);

  const status = await getJson(baseUrl, '/api/status');

  assert.equal(status.reader.running, false);
  assert.equal(status.reader.pid, null);
  assert.equal(status.telegram.hasUnreadInbox, false);
  assert.equal(status.telegram.unreadDialogCount, 0);
  assert.deepEqual(status.telegram.unreadDialogs, []);
});

test('status shows when archive was last read', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.readerStatusFile, JSON.stringify({
    archiveLastReadAt: '2026-06-12T03:45:14Z',
    archiveProcessedDialogCount: 6,
    archiveFoundDialogCount: 6,
    archiveError: null,
  }));
  const { baseUrl } = await startServer(t, fixture);

  const status = await getJson(baseUrl, '/api/status');

  assert.equal(status.archive.lastReadAt, '2026-06-12T03:45:14Z');
  assert.equal(status.archive.nextReadAt, '2026-06-12T03:50:14.000Z');
  assert.equal(status.archive.processedDialogCount, 6);
  assert.equal(status.archive.foundDialogCount, 6);
  assert.equal(status.archive.error, null);
});

test('status surfaces exact unread non-archived dialogs from helper', async (t) => {
  const fixture = await createFixture(t);
  await writeTelegramState(fixture.helperState, {
    hasUnreadInbox: true,
    unreadDialogCount: 2,
    unreadDialogs: [
      { title: 'Клиентократия', unreadCount: 111, type: 'group', archived: false },
      { title: '🪷', unreadCount: 3, type: 'group', archived: false },
    ],
    checkedAt: new Date().toISOString(),
    error: null,
  });
  const { baseUrl } = await startServer(t, fixture);

  const status = await getJson(baseUrl, '/api/status');

  assert.equal(status.telegram.hasUnreadInbox, true);
  assert.equal(status.telegram.unreadDialogCount, 2);
  assert.equal(status.telegram.unreadDialogs[0].title, 'Клиентократия');
  assert.equal(status.telegram.unreadDialogs[1].title, '🪷');
});

test('archived unread messages are not counted by the status contract', async (t) => {
  const fixture = await createFixture(t);
  await writeTelegramState(fixture.helperState, {
    hasUnreadInbox: false,
    unreadDialogCount: 0,
    unreadDialogs: [],
    ignoredArchivedDialogCount: 4,
    checkedAt: new Date().toISOString(),
    error: null,
  });
  const { baseUrl } = await startServer(t, fixture);

  const status = await getJson(baseUrl, '/api/status');

  assert.equal(status.telegram.hasUnreadInbox, false);
  assert.equal(status.telegram.unreadDialogCount, 0);
  assert.equal(status.telegram.ignoredArchivedDialogCount, 4);
});

test('reader can be started, stopped, and restarted through the API', async (t) => {
  const fixture = await createFixture(t);
  const { baseUrl } = await startServer(t, fixture);

  const started = await postJson(baseUrl, '/api/reader/start');
  assert.equal(started.response.status, 200);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.reader.running, true);

  const runningStatus = await getJson(baseUrl, '/api/status');
  assert.equal(runningStatus.reader.running, true);
  assert.equal(Number.isInteger(runningStatus.reader.pid), true);

  const restarted = await postJson(baseUrl, '/api/reader/restart');
  assert.equal(restarted.response.status, 200);
  assert.equal(restarted.body.ok, true);
  assert.equal(restarted.body.reader.running, true);

  const stopped = await postJson(baseUrl, '/api/reader/stop');
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.body.ok, true);
  assert.equal(stopped.body.reader.running, false);
});

test('reader control endpoints reject cross-origin POST requests', async (t) => {
  const fixture = await createFixture(t);
  const { baseUrl } = await startServer(t, fixture);

  const blocked = await postJson(baseUrl, '/api/reader/start', {
    headers: { Origin: 'http://example.com' },
  });

  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error, 'Forbidden origin');
});

test('vk session status validates configured token without exposing it', async (t) => {
  const fixture = await createFixture(t);
  const vkApiBaseUrl = await startFakeVkApi(t, async (req, res) => {
    assert.equal(req.url, '/messages.getConversations');
    const body = await readFormBody(req);
    assert.equal(body.get('access_token'), 'valid-token');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response: { count: 1, items: [] } }));
  });
  const { baseUrl } = await startServer(t, fixture, {
    VK_API_BASE_URL: vkApiBaseUrl,
    VK_ACCESS_TOKEN: 'valid-token',
  });

  const session = await getJson(baseUrl, '/api/vk/session');

  assert.equal(session.valid, true);
  assert.equal(session.configured, true);
  assert.equal(JSON.stringify(session).includes('valid-token'), false);
});

test('vk token endpoint saves only a valid token to env file', async (t) => {
  const fixture = await createFixture(t);
  const vkApiBaseUrl = await startFakeVkApi(t, async (req, res) => {
    const body = await readFormBody(req);
    const token = body.get('access_token');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (token === 'valid-token') {
      res.end(JSON.stringify({ response: { count: 0, items: [] } }));
    } else {
      res.end(JSON.stringify({ error: { error_code: 5, error_msg: 'User authorization failed' } }));
    }
  });
  const { baseUrl } = await startServer(t, fixture, { VK_API_BASE_URL: vkApiBaseUrl });

  const rejected = await postJson(baseUrl, '/api/vk/token', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'bad-token' }),
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.ok, false);

  const accepted = await postJson(baseUrl, '/api/vk/token', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'valid-token' }),
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.ok, true);
  assert.equal(accepted.body.session.valid, true);

  const envFile = await readFile(fixture.envFile, 'utf8');
  assert.match(envFile, /VK_ACCESS_TOKEN="valid-token"/);
});

test('vk token endpoint rejects cross-origin POST requests', async (t) => {
  const fixture = await createFixture(t);
  const { baseUrl } = await startServer(t, fixture);

  const blocked = await postJson(baseUrl, '/api/vk/token', {
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://example.com',
    },
    body: JSON.stringify({ token: 'valid-token' }),
  });

  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error, 'Forbidden origin');
});
