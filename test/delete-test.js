const fs = require('fs');
const path = require('path');
const { start } = require('./mock-sftp');

const API = 'http://127.0.0.1:8765';
const PORT = 2225;
const SANDBOX = path.join(__dirname, 'sandbox-del');
const DIR = '/mnt/us/documents';
const RESET = { host: '', port: 2222, username: 'root', password: '', privateKey: '', remoteDir: DIR };

let pass = 0, fail = 0;
const check = (l, c, x) => { c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l + (x ? '  → ' + JSON.stringify(x) : ''))); };
const put = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

(async () => {
  const srv = await start(PORT, SANDBOX);
  const base = path.join(SANDBOX, 'mnt', 'us', 'documents');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  put(path.join(base, 'single.epub'), 'A');
  put(path.join(base, 'book.epub'), 'B');
  put(path.join(base, 'book.sdr', 'metadata.epub.lua'), 'progress');
  put(path.join(base, 'book.sdr', 'cache', 'x.lua'), 'cache');
  put(path.join(base, '系列', '第一本.epub'), 'C');

  await fetch(API + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: PORT, username: 'root', password: '', privateKey: '', remoteDir: DIR }),
  });

  let r = await fetch(API + '/api/file?path=' + encodeURIComponent(DIR + '/single.epub'), { method: 'DELETE' });
  let d = await r.json();
  check('删除单个文件', d.ok === true, d);
  check('文件真的没了', !fs.existsSync(path.join(base, 'single.epub')));

  r = await fetch(API + '/api/file?path=' + encodeURIComponent(DIR + '/book.sdr'), { method: 'DELETE' });
  d = await r.json();
  check('删除非空目录 (.sdr)', d.ok === true, d);
  check('递归删了 4 项（2 文件 + 2 层目录）', d.removed === 4, { got: d.removed });
  check('目录真的没了', !fs.existsSync(path.join(base, 'book.sdr')));

  r = await fetch(API + '/api/file?path=' + encodeURIComponent(DIR + '/系列'), { method: 'DELETE' });
  d = await r.json();
  check('删除含中文名的目录', d.ok === true, d);
  check('中文目录已清空', !fs.existsSync(path.join(base, '系列')));

  check('旁边那本书没被误删', fs.existsSync(path.join(base, 'book.epub')));

  r = await fetch(API + '/api/file?path=' + encodeURIComponent('/mnt/us/koreader/settings'), { method: 'DELETE' });
  d = await r.json();
  check('越界路径被拒绝', d.ok === false && r.status === 403, { status: r.status, d });

  r = await fetch(API + '/api/file?path=' + encodeURIComponent(DIR + '/../koreader'), { method: 'DELETE' });
  d = await r.json();
  check('.. 穿越被拒绝', d.ok === false, { d });

  await fetch(API + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(RESET),
  });
  srv.close();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败（连接配置已清空）');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
