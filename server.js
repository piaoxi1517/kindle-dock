'use strict';

/*
 * Kindle Dock —— 本地轻量「投书」服务
 * 浏览器拖拽 -> 本机 HTTP -> SFTP -> Kindle（/mnt/us/documents）
 * 依赖：仅 ssh2（纯 JS，无需编译）
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

/* 单文件 exe（Node SEA）下，资源内嵌、工作目录跟随 exe 所在位置 */
let seaMod = null;
try { seaMod = require('node:sea'); } catch (_) { /* 普通 node 运行 */ }
const IS_SEA = Boolean(seaMod && typeof seaMod.isSea === 'function' && seaMod.isSea());

const ROOT = IS_SEA ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 允许用 DATA_DIR 指定配置目录（多实例调试 / 自动化测试时避免污染真实配置）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const START_PORT = Number(process.env.PORT || 8765);
const BIND = process.env.HOST || '127.0.0.1';

const DEFAULT_CONFIG = {
  host: '',
  port: 2222,
  username: 'root',
  password: '',
  privateKey: '',
  remoteDir: '/mnt/us/documents',
};

/* ---------------------------- 配置读写 ---------------------------- */

async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(cfg) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function sanitizeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : null;
}

/* ---------------------------- SSH / SFTP ---------------------------- */

function connect(cfg) {
  return new Promise((resolve, reject) => {
    if (!cfg.host) return reject(new Error('NO_HOST'));
    const conn = new Client();
    let settled = false;
    const pwd = cfg.password == null ? '' : String(cfg.password);
    let triedKey = false;
    let triedPwd = false;
    let triedKi = false;
    let authMethods = null; // 服务端声明支持的方式，失败时带进错误里

    const opts = {
      host: cfg.host,
      port: Number(cfg.port) || 2222,
      username: cfg.username || 'root',
      readyTimeout: 15000,
      tryKeyboard: true,
      authHandler: (methodsLeft, partialSuccess, callback) => {
        if (!authMethods && Array.isArray(methodsLeft) && methodsLeft.length) authMethods = methodsLeft;
        // methodsLeft 为 null 表示首次调用；有值时只挑服务端真正接受的方式
        const allowed = Array.isArray(methodsLeft) && methodsLeft.length ? methodsLeft : null;
        const can = (m) => !allowed || allowed.includes(m);

        // 私钥优先
        if (cfg.privateKey && !triedKey && can('publickey')) {
          triedKey = true;
          return callback({
            type: 'publickey',
            username: opts.username,
            privateKey: cfg.privateKey,
            passphrase: cfg.passphrase || undefined,
          });
        }
        // Kindle 上 dropbear 常见形态：空密码 / 或 root 密码
        if (!triedPwd && can('password')) {
          triedPwd = true;
          return callback({ type: 'password', username: opts.username, password: pwd });
        }
        // 某些 dropbear 走 keyboard-interactive 承载空密码
        if (cfg.tryKeyboard !== false && !triedKi && can('keyboard-interactive')) {
          triedKi = true;
          return callback({
            type: 'keyboard-interactive',
            username: opts.username,
            prompt: (name, instructions, lang, prompts, finish) => finish(prompts.map(() => pwd)),
          });
        }
        const e = new Error('AUTH_FAILED');
        e.authMethods = authMethods;
        return callback(e);
      },
    };

    conn.on('ready', () => {
      if (!settled) {
        settled = true;
        resolve(conn);
      }
    });
    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        if (authMethods) err.authMethods = authMethods;
        reject(err);
      }
    });
    conn.connect(opts);
  });
}

function getSftp(conn) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('SFTP_TIMEOUT'));
    }, 20000);
    conn.sftp((err, sftp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      return err ? reject(err) : resolve(sftp);
    });
  });
}

function ensureDir(sftp, dir) {
  const abs = dir.replace(/\/+$/, '') || '/';
  const parts = abs.split('/').filter(Boolean);
  let cur = abs.startsWith('/') ? '' : '.';
  return parts.reduce(
    (chain, part) =>
      chain.then(
        () =>
          new Promise((resolve) => {
            cur = `${cur}/${part}`;
            sftp.mkdir(cur, () => resolve()); // 已存在就忽略
          })
      ),
    Promise.resolve()
  );
}

function putStream(sftp, readable, remotePath) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const ws = sftp.createWriteStream(remotePath);
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { ws.destroy(); } catch {}
        reject(err);
      } else {
        resolve(bytes);
      }
    };
    ws.on('close', () => finish(null));
    ws.on('error', (err) => finish(err));
    readable.on('error', (err) => finish(err));
    readable.on('data', (chunk) => { bytes += chunk.length; });
    readable.pipe(ws);
  });
}

function listDir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return reject(err);
      const items = list
        .filter((it) => it.filename !== '.' && it.filename !== '..')
        .map((it) => ({
          name: it.filename,
          size: it.attrs.size,
          mtime: it.attrs.mtime * 1000,
          isDir: (it.attrs.mode & 0o040000) === 0o040000,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      resolve(items);
    });
  });
}

function statPath(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st)));
  });
}

/* 递归删除：文件走 unlink，目录先清空再 rmdir */
async function removePath(sftp, target) {
  const st = await statPath(sftp, target);
  const isDir = (st.mode & 0o040000) === 0o040000;
  if (!isDir) {
    await new Promise((resolve, reject) => sftp.unlink(target, (e) => (e ? reject(e) : resolve())));
    return 1;
  }
  const base = target.replace(/\/+$/, '');
  const items = await listDir(sftp, base);
  let n = 0;
  for (const it of items) {
    n += await removePath(sftp, `${base}/${it.name}`);
  }
  await new Promise((resolve, reject) => sftp.rmdir(base, (e) => (e ? reject(e) : resolve())));
  return n + 1;
}

/* ---------------------------- 错误翻译 ---------------------------- */

function explain(err) {
  const msg = String((err && (err.message || err)) || '');
  const code = err && err.code;
  if (msg === 'NO_HOST') return '还没配置 Kindle 的地址，先在「设置」里填 IP。';
  if (msg === 'SFTP_TIMEOUT') return 'SSH 连上了，但 20 秒内没拿到 SFTP 通道。多半是设备端 SSH 服务没装 sftp 子系统，或设备太慢/休眠了。';
  if (code === 'ECONNREFUSED') return '端口拒绝连接：Kindle 上的 KOReader 没开 SSH 服务器，或端口不是 2222。';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET')
    return '连不上这台设备：确认 Kindle 和电脑连的是同一个 WiFi（手机热点也行），Kindle 没有熄屏休眠，IP 没变过。';
  if (code === 'ENOTFOUND') return 'IP 地址解析失败，检查填的是不是局域网地址（形如 192.168.x.x）。';
  if (/All configured authentication methods failed|AUTH_FAILED/i.test(msg)) {
    const m = err && Array.isArray(err.authMethods) && err.authMethods.length
      ? `服务端只接受 ${err.authMethods.join(' / ')}，`
      : '';
    const keyOnly = err && Array.isArray(err.authMethods) && err.authMethods.length === 1 && err.authMethods[0] === 'publickey';
    if (keyOnly) return '这台设备只接受公钥登录：需要把公钥写入 /mnt/us/koreader/settings/SSH/authorized_keys，然后在「设置」里把登录方式改成「私钥」。';
    return `认证被拒（${m}密码方式没通过）：在 KOReader 的「SSH 服务器」菜单里勾选「登录无需密码 Login without password」，然后关闭服务器再重新打开——改完开关必须重启服务才生效。`;
  }
  if (/Cannot parse privateKey|privateKey/i.test(msg)) return '私钥格式不对，请粘贴完整的一行 OpenSSH 私钥（以 -----BEGIN OPENSSH PRIVATE KEY----- 开头）。';
  if (/No SFTP subsystem|subsystem/i.test(msg)) return '设备没有开放 SFTP 子系统，这条链路在你这台机器上用不了，改用内置 SSH 的管道传文件。';
  if (/no matching|algorithm negotiation|unsupported algorithm/i.test(msg))
    return '加密算法协商失败：这台设备的 SSH 服务太旧。先确认连的是 KOReader 的 SSH 服务器（端口 2222），不是别的服务。';
  if (code === 2 || /No such file/i.test(msg)) return '远程目录不存在，检查路径是不是 /mnt/us/documents。';
  if (code === 3) return '权限不足（Permission denied），这个文件或目录不可写或不可删。';
  if (code === 4) return '服务端拒绝了这次操作（Failure）：常见于对文件夹做删文件操作、或文件被占用。';
  return msg || '未知错误';
}

/* ---------------------------- HTTP 工具 ---------------------------- */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');

  let data = null;
  if (IS_SEA) {
    try { data = Buffer.from(seaMod.getAsset(rel)); } catch (_) { data = null; }
  } else {
    const full = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try { data = await fsp.readFile(full); } catch (_) { data = null; }
  }

  if (!data) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/* ---------------------------- 路由 ---------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const q = url.searchParams;

  try {
    if (p === '/api/config' && req.method === 'GET') {
      const cfg = await loadConfig();
      return sendJson(res, 200, { ...cfg, configured: Boolean(cfg.host) });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = { ...DEFAULT_CONFIG, ...body };
      cfg.port = Number(cfg.port) || 2222;
      cfg.username = cfg.username || 'root';
      cfg.remoteDir = cfg.remoteDir || '/mnt/us/documents';
      cfg.password = cfg.password == null ? '' : String(cfg.password);
      await saveConfig(cfg);
      return sendJson(res, 200, { ok: true, ...cfg, configured: Boolean(cfg.host) });
    }

    if (p === '/api/test' && req.method === 'POST') {
      const cfg = await loadConfig();
      const started = Date.now();
      let conn;
      try {
        conn = await connect(cfg);
        const sftp = await getSftp(conn);
        let entries = [];
        let dirWarning = '';
        try {
          entries = await listDir(sftp, cfg.remoteDir);
        } catch {
          dirWarning = `连上了，但目录 ${cfg.remoteDir} 读不到，检查路径。`;
        }
        return sendJson(res, 200, {
          ok: true,
          ms: Date.now() - started,
          host: cfg.host,
          port: cfg.port,
          remoteDir: cfg.remoteDir,
          count: entries.length,
          warning: dirWarning,
        });
      } catch (err) {
        return sendJson(res, 200, { ok: false, reason: explain(err), raw: String(err.message || err) });
      } finally {
        if (conn) conn.end();
      }
    }

    if (p === '/api/list' && req.method === 'GET') {
      const cfg = await loadConfig();
      const dir = q.get('dir') || cfg.remoteDir;
      let conn;
      try {
        conn = await connect(cfg);
        const sftp = await getSftp(conn);
        const items = await listDir(sftp, dir);
        return sendJson(res, 200, { ok: true, dir, items });
      } catch (err) {
        return sendJson(res, 200, { ok: false, reason: explain(err) });
      } finally {
        if (conn) conn.end();
      }
    }

    if (p === '/api/upload' && req.method === 'PUT') {
      const cfg = await loadConfig();
      const name = sanitizeName(q.get('name'));
      if (!name) return sendJson(res, 400, { ok: false, reason: '文件名不合法' });
      const dir = q.get('dir') || cfg.remoteDir;
      const remotePath = `${dir.replace(/\/+$/, '')}/${name}`;
      const started = Date.now();
      let clientGone = false;
      req.on('close', () => { if (!req.readableEnded) clientGone = true; });
      let conn;
      let sftpRef = null;
      try {
        conn = await connect(cfg);
        const sftp = await getSftp(conn);
        sftpRef = sftp;
        await ensureDir(sftp, dir);
        const bytes = await putStream(sftp, req, remotePath);
        if (clientGone) throw new Error('ABORTED');
        console.log(`[upload] ${name} -> ${remotePath} (${bytes} bytes, ${Date.now() - started}ms)`);
        return sendJson(res, 200, { ok: true, name, path: remotePath, size: bytes, ms: Date.now() - started });
      } catch (err) {
        const aborted = clientGone || /ABORTED/.test(err.message);
        console.error(`[upload] ${aborted ? '已中断' : '失败'}: ${name} — ${err.message}`);
        // 中断会留下半截文件，清掉，避免 Kindle 上出现打不开的残书
        if (sftpRef) {
          await new Promise((resolve) => sftpRef.unlink(remotePath, () => resolve()));
        }
        if (aborted) {
          if (!res.writableEnded) sendJson(res, 200, { ok: false, aborted: true, reason: '已取消，设备上的残缺文件已清理' });
          return;
        }
        return sendJson(res, 200, { ok: false, reason: explain(err) });
      } finally {
        if (conn) conn.end();
      }
    }

    if (p === '/api/file' && req.method === 'DELETE') {
      const cfg = await loadConfig();
      const target = q.get('path');
      if (!target) return sendJson(res, 400, { ok: false, reason: '缺少 path 参数' });
      // 安全边界：只允许删除远程书库目录内的东西
      const root = cfg.remoteDir.replace(/\/+$/, '');
      const norm = path.posix.normalize(target);
      if (!root || !(norm === root || norm.startsWith(root + '/')) || norm.includes('..')) {
        return sendJson(res, 403, { ok: false, reason: `拒绝删除：只允许操作 ${root} 之内的文件` });
      }
      let conn;
      try {
        conn = await connect(cfg);
        const sftp = await getSftp(conn);
        const removed = await removePath(sftp, norm);
        console.log(`[delete] ${norm} (${removed} 项)`);
        return sendJson(res, 200, { ok: true, removed });
      } catch (err) {
        console.error('[delete] failed:', err.message);
        return sendJson(res, 200, { ok: false, reason: explain(err) });
      } finally {
        if (conn) conn.end();
      }
    }

    if (p === '/api/file' && req.method === 'GET') {
      const cfg = await loadConfig();
      const target = q.get('path');
      if (!target) return sendJson(res, 400, { ok: false, reason: '缺少 path 参数' });
      let conn;
      try {
        conn = await connect(cfg);
        const sftp = await getSftp(conn);
        const st = await statPath(sftp, target);
        const filename = path.basename(target);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        });
        const rs = sftp.createReadStream(target);
        rs.on('error', () => res.destroy());
        rs.pipe(res);
        res.on('close', () => conn.end());
      } catch (err) {
        if (conn) conn.end();
        return sendJson(res, 200, { ok: false, reason: explain(err) });
      }
      return;
    }

    if (p === '/api/health') return sendJson(res, 200, { ok: true, app: 'kindle-dock' });

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p);

    sendJson(res, 404, { ok: false, reason: 'Not found' });
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, reason: String(err.message || err) });
    else res.destroy();
  }
});

/* 大文件上传时不因为 socket 超时而中断 */
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

const urlOf = (port) => `http://127.0.0.1:${port}`;

function openBrowser(url) {
  if (process.env.NO_OPEN === '1') return;
  const run = (cmd, args, onFail) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { if (onFail) onFail(); });
    child.unref();
  };
  if (process.platform === 'win32') {
    // rundll32 直接交给默认浏览器，不经过 cmd，不会有黑色窗口闪一下
    run('rundll32', ['url.dll,FileProtocolHandler', url], () =>
      run('cmd', ['/c', 'start', '', url])
    );
  } else if (process.platform === 'darwin') {
    run('open', [url]);
  } else {
    run('xdg-open', [url]);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 双击运行时窗口一闪而过就看不到错误了，这里停住等回车，同时落一份日志 */
function fatal(msg) {
  const text = String(msg && msg.message ? msg.message : msg);
  console.error('\n  启动失败：' + text + '\n');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'last-error.log'),
      `[${new Date().toISOString()}] ${text}\n${(msg && msg.stack) || ''}\n`,
      'utf8'
    );
    console.error('  详细日志：' + path.join(DATA_DIR, 'last-error.log'));
  } catch (_) { /* 忽略 */ }

  if (process.stdin.isTTY) {
    console.error('  按回车键关闭窗口…\n');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
    setTimeout(() => process.exit(1), 60000).unref();
  } else {
    process.exit(1);
  }
}

function probeRunning(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 900 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(b.includes('kindle-dock')));
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}

function tryListen(port) {
  return new Promise((resolve) => {
    const onError = (err) => { server.removeListener('listening', onListening); resolve(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(null); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND);
  });
}

function banner(port) {
  console.log('');
  console.log('  Kindle Dock 已启动');
  console.log(`  页面： ${urlOf(port)}`);
  console.log(`  绑定： ${BIND}:${port}  （仅本机可访问）`);
  console.log(`  配置： ${CONFIG_FILE}`);
  console.log(`  模式： ${IS_SEA ? '单文件 exe' : 'node server.js'}`);
  console.log('  关闭： 按 Ctrl+C，或直接关掉这个窗口');
  console.log('');
}

async function boot() {
  for (let port = START_PORT; port < START_PORT + 10; port++) {
    const err = await tryListen(port);
    if (!err) {
      banner(port);
      if (IS_SEA || process.argv.includes('--open')) openBrowser(urlOf(port));
      return;
    }
    if (err.code === 'EADDRINUSE') {
      if (await probeRunning(port)) {
        console.log('');
        console.log(`  Kindle Dock 已经在运行：${urlOf(port)}`);
        console.log('  正在帮你打开浏览器…');
        console.log('  不需要重复启动，关掉这个窗口不影响已在跑的那个。');
        console.log('');
        openBrowser(urlOf(port));
        await sleep(1200); // 留出时间让浏览器起来、也让用户看清这行提示
        process.exit(0);
      }
      continue;
    }
    return fatal(err);
  }
  fatal(new Error(`端口 ${START_PORT} ~ ${START_PORT + 9} 全被占用。换一个端口再启动：set PORT=9000`));
}

boot();

process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
