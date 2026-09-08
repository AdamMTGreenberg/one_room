// Isolated deployment test. Never uses the default Compose project's data.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(path.join(tmpdir(), 'oneroom-docker-'));
const project = `oneroom-audit-${Date.now()}`;
const override = path.join(dir, 'compose.yml');
writeFileSync(override, 'services:\n  oneroom:\n    healthcheck:\n      interval: 1s\n      timeout: 3s\n      retries: 30\n');
const args = ['compose', '-p', project, '-f', path.resolve('docker-compose.yml'), '-f', override];
function docker(command) {
  const result = spawnSync('docker', command, { encoding: 'utf8', env: { ...process.env, ONEROOM_PORT: '0', ONEROOM_MAX_DB_MB: '256', ONEROOM_MAX_MESSAGE_KB: '64', ONEROOM_MAX_DOC_KB: '512', ONEROOM_RETENTION_DAYS: '0' }, timeout: 240_000 });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? 'Docker failed');
  return result.stdout.trim();
}
function compose(command) { return docker([...args, ...command]); }
try {
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '60']);
  const id = compose(['ps', '-q', 'oneroom']);
  const [container] = JSON.parse(docker(['inspect', id]));
  assert.equal(container.Config.User, 'node');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(container.HostConfig.PidsLimit, 64);
  assert.equal(container.NetworkSettings.Ports['7777/tcp'][0].HostIp, '127.0.0.1');
  const exercise = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const key = fs.readFileSync('/data/oneroom.key', 'utf8').trim();
    assert.equal(fs.statSync('/data/oneroom.key').mode & 511, 384);
    const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    (async () => {
      assert.equal((await fetch('http://127.0.0.1:7777/export')).status, 401);
      const before = await fetch('http://127.0.0.1:7777/export', {headers}).then(r => r.json());
      if (process.env.VERIFY_RESTART) {
        assert.equal(before.messages.length, 1);
        assert.equal(before.messages[0].content, 'survives restart');
        await fetch('http://127.0.0.1:7777/mcp', {method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'post_message',arguments:{request_id:'docker-restart-write',content:'survives restart'}}})}).then(r=>r.text());
        const replay = await fetch('http://127.0.0.1:7777/export', {headers}).then(r=>r.json());
        assert.equal(replay.messages.length, 1);
      } else {
        assert.equal(before.messages.length, 0);
        const response = await fetch('http://127.0.0.1:7777/mcp', {method:'POST',headers, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'post_message',arguments:{request_id:'docker-restart-write',content:'survives restart'}}})});
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(!body.includes('"isError":true'), body);
        const after = await fetch('http://127.0.0.1:7777/export', {headers}).then(r => r.json());
        assert.equal(after.messages.length, 1);
      }
    })().catch(e => { console.error(e.message); process.exitCode=1; });
  `;
  const keyDigestCommand = ['exec', '-T', 'oneroom', 'node', '-e', "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/data/oneroom.key')).digest('hex'))"];
  const keyDigest = compose(keyDigestCommand);
  compose(['exec', '-T', 'oneroom', 'node', '-e', exercise]);
  compose(['stop']);
  const [stopped] = JSON.parse(docker(['inspect', id]));
  assert.equal(stopped.State.ExitCode, 0, 'graceful stop should exit cleanly');
  compose(['up', '-d', '--wait', '--wait-timeout', '60']);
  assert.equal(compose(keyDigestCommand), keyDigest, 'access key persists across restart');
  compose(['exec', '-T', '-e', 'VERIFY_RESTART=1', 'oneroom', 'node', '-e', exercise]);
  console.log('DOCKER OK — non-root first boot, limits, loopback binding, MCP, export, graceful stop, restart persistence');
} finally {
  compose(['down', '-v', '--remove-orphans', '--rmi', 'local']);
  rmSync(dir, { recursive: true, force: true });
}
