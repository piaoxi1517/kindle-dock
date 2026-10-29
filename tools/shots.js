'use strict';
/*
 * 生成产品截图（营销用）
 * 用系统里已有的 Chrome/Edge，不下载浏览器；用 mock SFTP 服务模拟 Kindle，不碰真机。
 * 用法：node tools/shots.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const { start: startMock } = require('../test/mock-sftp');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'marketing', 'shots');
const TMP = path.join(ROOT, '.shots-tmp');
const DATA = path.join(TMP, 'data');
const SANDBOX = path.join(TMP, 'kindle');
const UPLOADS = path.join(TMP, 'uploads');
const APP_PORT = 8790;
const MOCK_PORT = 2228;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const BOOKS = [
  ['三体（全集）.epub', 3_412_736],
  ['活着.epub', 1_258_291],
  ['百年孤独.epub', 2_097_152],
  ['人类简史.pdf', 12_582_912],
  ['卡拉马佐夫兄弟.epub', 4_194_304],
  ['置身事内.epub', 6_291_456],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) throw new Error('没找到 Chrome 或 Edge');
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'mnt', 'us', 'documents'), { recursive: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  // 假书库：真实大小 + 递增时间，看起来像长期积累
  const docs = path.join(SANDBOX, 'mnt', 'us', 'documents');
  const now = Date.now();
  BOOKS.forEach(([name, size], i) => {
    const f = path.join(docs, name);
    fs.writeFileSync(f, Buffer.alloc(64)); // 占位内容
    const t = new Date(now - (i + 1) * 86400000 * 3);
    fs.utimesSync(f, t, t);
    fs.truncateSync(f, size); // 撑出真实大小（稀疏文件，不占磁盘）
  });
  fs.mkdirSync(path.join(docs, '三体（全集）.sdr'), { recursive: true });

  const mock = await startMock(MOCK_PORT, SANDBOX);
  console.log('mock Kindle 已启动 :' + MOCK_PORT);

  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), NO_OPEN: '1', DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => console.error('[app]', String(d).trim()));
  await sleep(1500);

  const base = `http://127.0.0.1:${APP_PORT}`;
  await fetch(base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host: '127.0.0.1', port: MOCK_PORT, username: 'root',
      password: '', privateKey: '', remoteDir: '/mnt/us/documents',
    }),
  });

  // 待上传的文件
  const files = ['山茶文具店.epub', '夜晚的潜水艇.epub', '如何阅读一本书.pdf'].map((n, i) => {
    const p = path.join(UPLOADS, n);
    fs.writeFileSync(p, Buffer.alloc(1024 * (200 + i * 150), 0x42));
    return p;
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN', '--hide-scrollbars'],
  });

  const hideToast = async (pg) => {
    await pg.evaluate(() => {
      const t = document.getElementById('toast');
      if (t) t.className = 'toast';
    });
    await sleep(320);
  };

  const shoot = async (page, name, clip) => {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file, clip });
    console.log('  ✓ ' + name);
  };

  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 760, deviceScaleFactor: 2 });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('已连接'),
    { timeout: 15000 }
  );
  await sleep(1200);
  await hideToast(page);
  await shoot(page, '01-upload.png');

  // 队列：3 个文件全部入队 + 传完
  const input = await page.$('#fileInput');
  await input.uploadFile(...files);
  await page.waitForFunction(
    () => document.querySelectorAll('#queue .qi.ok').length === 3,
    { timeout: 20000 }
  );
  await sleep(600);
  await hideToast(page);
  await shoot(page, '02-queue.png');

  // 书架
  await page.click('.tab[data-tab="shelf"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#rows .row').length > 3,
    { timeout: 15000 }
  );
  await sleep(800);
  await hideToast(page);
  await shoot(page, '03-shelf.png');

  // 设置 + 连接自检
  await page.click('#btnSettings');
  await page.click('#btnTest');
  await page.waitForFunction(
    () => document.querySelector('#testResult.ok'),
    { timeout: 20000 }
  );
  await sleep(600);
  await hideToast(page);
  const modal = await page.$('.modal');
  const box = await modal.boundingBox();
  await shoot(page, '04-settings.png', {
    x: Math.round(box.x - 30),
    y: Math.round(box.y - 30),
    width: Math.round(box.width + 60),
    height: Math.round(box.height + 60),
  });

  // 封面 1080x1440
  const cover = await browser.newPage();
  await cover.setViewport({ width: 1080, height: 1440, deviceScaleFactor: 1 });
  const coverHtml = path.join(TMP, 'cover.html');
  fs.writeFileSync(coverHtml, buildCover(), 'utf8');
  await cover.goto('file:///' + coverHtml.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await sleep(500);
  await shoot(cover, '00-cover.png');

  await browser.close();
  app.kill();
  mock.close();
  await sleep(300);

  console.log('\n产出目录：' + OUT);
  fs.readdirSync(OUT).forEach((f) =>
    console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB')
  );
}

function buildCover() {
  const shot = 'file:///' + path.join(OUT, '01-upload.png').replace(/\\/g, '/');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{
    width:1080px;height:1440px;background:#f7f6f3;overflow:hidden;
    font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#1c1917;
    display:flex;flex-direction:column;padding:72px 64px 56px;position:relative;
  }
  .tagline{font-size:26px;color:#8a8578;letter-spacing:2px;margin-bottom:26px;}
  h1{font-size:82px;line-height:1.24;font-weight:800;letter-spacing:-1px;}
  h1 em{font-style:normal;color:#2563eb;}
  .sub{margin-top:28px;font-size:30px;line-height:1.6;color:#57534e;}
  .shot{
    margin-top:56px;border-radius:22px;overflow:hidden;
    box-shadow:0 24px 60px rgba(28,25,23,.16),0 0 0 1px rgba(28,25,23,.07);
    width:952px;
  }
  .shot img{width:100%;display:block;height:474px;object-fit:cover;object-position:top;}
  .steps{display:flex;align-items:center;gap:16px;margin-top:42px;}
  .step{
    flex:1;background:#fff;border:1px solid #e6e2da;border-radius:16px;
    padding:22px 20px;font-size:25px;color:#3f3b36;line-height:1.4;
  }
  .step b{display:block;font-size:19px;color:#a8a29e;font-weight:500;margin-bottom:8px;letter-spacing:1px;}
  .arrow{color:#c9c3b6;font-size:30px;}
  .chips{display:flex;gap:14px;margin-top:auto;padding-top:34px;}
  .chip{
    font-size:25px;padding:14px 26px;border-radius:999px;background:#fff;
    border:1px solid #e0ddd6;color:#44403c;
  }
  .repo{
    margin-top:22px;font-size:23px;color:#a8a29e;text-align:right;
    font-family:ui-monospace,Consolas,monospace;
  }
</style></head><body>
  <div class="tagline">越狱 KINDLE + KOREADER 玩家向</div>
  <h1>把书拖进浏览器<br>就<em>进了 Kindle</em></h1>
  <div class="sub">不用数据线，不用 FileZilla<br>一个本地网页搞定无线传书</div>
  <div class="shot"><img src="${shot}"></div>
  <div class="steps">
    <div class="step"><b>STEP 1</b>把 epub 拖进网页</div>
    <div class="arrow">→</div>
    <div class="step"><b>STEP 2</b>自动写进设备</div>
    <div class="arrow">→</div>
    <div class="step"><b>STEP 3</b>KOReader 刷新</div>
  </div>
  <div class="chips">
    <div class="chip">开源 GPL-3.0</div>
    <div class="chip">免装客户端</div>
    <div class="chip">单文件 exe</div>
  </div>
  <div class="repo">github.com/piaoxi1517/kindle-dock</div>
</body></html>`;
}

main().catch((e) => {
  console.error('失败：', e);
  process.exit(1);
});
