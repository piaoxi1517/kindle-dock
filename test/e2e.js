'use strict';
/*
 * 端到端自测：起一个 mock SFTP -> 通过 HTTP API 走完整条链路
 * 前提：server.js 已在 8765 运行
 */

const fs = require('fs');
const path = require('path');
const { start } = require('./mock-sftp');

const API = 'http://127.0.0.1:8765';
const SFTP_PORT = 2223;
const SANDBOX = path.join(__dirname, 'sandbox');
const REMOTE_DIR = '/mnt/us/documents';
const NAME = '测试 书籍.epub';
const CONTENT = Buffer.from('这是一个用于端到端验证的假 EPUB 文件。\n'.repeat(500) + 'END');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

async function main() {
  const server = await start(SFTP_PORT, SANDBOX);
  console.log('mock sftp 已启动 :' + SFTP_PORT + '\n');

  const cfg = {
    host: '127.0.0.1', port: SFTP_PORT, username: 'root',
    password: '', privateKey: '', remoteDir: REMOTE_DIR,
  };
  let r = await fetch(API + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  });
  check('保存配置', (await r.json()).ok === true);

  r = await fetch(API + '/api/test', { method: 'POST' });
  let d = await r.json();
  check('连接自检通过', d.ok === true, d);
  console.log('    延时 ' + d.ms + 'ms，目录内 ' + (d.count ?? '?') + ' 个条目');

  r = await fetch(API + '/api/upload?name=' + encodeURIComponent(NAME), { method: 'PUT', body: CONTENT });
  d = await r.json();
  check('上传返回成功', d.ok === true, d);
  check('字节数一致', d.size === CONTENT.length, { got: d.size, want: CONTENT.length });
  console.log('    路径 ' + d.path + '，耗时 ' + d.ms + 'ms');

  const landed = path.join(SANDBOX, 'mnt', 'us', 'documents', NAME);
  check('文件真的落盘', fs.existsSync(landed), landed);
  if (fs.existsSync(landed)) {
    check('内容完整无损坏', Buffer.compare(fs.readFileSync(landed), CONTENT) === 0);
  }

  r = await fetch(API + '/api/list');
  d = await r.json();
  check('书架能列出该书', d.ok && d.items.some((i) => i.name === NAME), d);

  r = await fetch(API + '/api/file?path=' + encodeURIComponent(REMOTE_DIR + '/' + NAME));
  const got = Buffer.from(await r.arrayBuffer());
  check('下载回读一致', Buffer.compare(got, CONTENT) === 0, { got: got.length });

  r = await fetch(API + '/api/file?path=' + encodeURIComponent(REMOTE_DIR + '/' + NAME), { method: 'DELETE' });
  d = await r.json();
  check('远程删除成功', d.ok === true, d);
  check('本地已不存在', !fs.existsSync(landed));

  // 还原成未配置状态，避免测试地址留在配置里
  await fetch(API + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '', port: 2222, username: 'root', password: '', privateKey: '', remoteDir: REMOTE_DIR }),
  });

  server.close();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
