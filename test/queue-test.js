/* 验证：多文件串行上传 + 中途取消后不留残缺文件 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { start } = require('./mock-sftp');

const API = 'http://127.0.0.1:8765';
const PORT = 2226;
const SANDBOX = path.join(__dirname, 'sandbox-q');
const DIR = '/mnt/us/documents';
const RESET = { host: '', port: 2222, username: 'root', password: '', privateKey: '', remoteDir: DIR };

let pass = 0, fail = 0;
const check = (l, c, x) => { c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l + (x ? '  → ' + JSON.stringify(x) : ''))); };
const base = () => path.join(SANDBOX, 'mnt', 'us', 'documents');

function putWithAbort(name, sizeBytes, abortAfter) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 8765, method: 'PUT',
      path: '/api/upload?name=' + encodeURIComponent(name),
      headers: { 'Content-Length': sizeBytes },
    }, (res) => { res.resume(); resolve('responded'); });
    req.on('error', () => resolve('client-aborted'));
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    const tick = () => {
      if (sent >= sizeBytes) return;
      if (sent >= abortAfter) { req.destroy(); return; }
      sent += chunk.length;
      req.write(chunk, () => setImmediate(tick));
    };
    tick();
  });
}

(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const srv = await start(PORT, SANDBOX);
  await fetch(API + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: PORT, username: 'root', password: '', privateKey: '', remoteDir: DIR }),
  });

  for (const n of ['书一.epub', '书二.epub', '书三.epub']) {
    const r = await fetch(API + '/api/upload?name=' + encodeURIComponent(n), { method: 'PUT', body: 'X'.repeat(10000) });
    const d = await r.json();
    check('串行上传 ' + n, d.ok === true, d);
  }
  check('三本都在设备上', ['书一.epub', '书二.epub', '书三.epub'].every(n => fs.existsSync(path.join(base(), n))));

  await putWithAbort('取消测试.epub', 6 * 1024 * 1024, 512 * 1024);
  await new Promise(r => setTimeout(r, 2500));
  const leftover = fs.existsSync(path.join(base(), '取消测试.epub'));
  check('取消上传后不留残缺文件', leftover === false, { path: path.join(base(), '取消测试.epub') });

  const list = await (await fetch(API + '/api/list')).json();
  check('列表里也没有它', list.ok && !list.items.some(i => i.name === '取消测试.epub'));
  check('原有的书没被波及', list.items.filter(i => i.name.endsWith('.epub')).length === 3, { n: list.items.length });

  await fetch(API + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(RESET) });
  srv.close();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败（连接配置已清空）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
