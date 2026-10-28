'use strict';
/*
 * 一键打包成单文件 exe（Node SEA）
 * 用法：npm run exe
 *
 * 原理：esbuild 把 server.js + ssh2 打成单个 CJS → Node 的 SEA 机制把 JS 和
 *      index.html 作为资源塞进一份 node.exe 的副本里 → postject 注入 blob。
 *      产物不依赖目标机器装 Node。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const EXE_NAME = 'Kindle投书.exe';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (msg) => console.log('\n▸ ' + msg);

const bin = (name) => {
  // 直接用 node 执行包内的 JS 入口，避开 Windows 上 .cmd 的引号问题
  const entry = name === 'esbuild' ? 'esbuild/bin/esbuild' : 'postject/dist/cli.js';
  return [process.execPath, path.join(ROOT, 'node_modules', entry)];
};

fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

step('打包 JS（esbuild）');
const [nodeExe, esbuildEntry] = bin('esbuild');
execFileSync(
  nodeExe,
  [
    esbuildEntry,
    'server.js',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    '--outfile=' + path.join(BUILD, 'app.cjs'),
    '--external:cpu-features',
    '--log-level=warning',
  ],
  { cwd: ROOT, stdio: 'inherit' }
);
console.log('  build/app.cjs → ' + (fs.statSync(path.join(BUILD, 'app.cjs')).size / 1024).toFixed(0) + ' KB');

step('生成 SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: ROOT, stdio: 'inherit' });

step('复制 node 运行时');
const target = path.join(DIST, EXE_NAME);
fs.copyFileSync(process.execPath, target);
console.log('  ' + target + '  (' + (fs.statSync(target).size / 1048576).toFixed(0) + ' MB)');

step('注入 blob');
const postjectEntry = bin('postject')[1];
execFileSync(
  process.execPath,
  [
    postjectEntry,
    target,
    'NODE_SEA_BLOB',
    path.join(BUILD, 'sea-prep.blob'),
    '--sentinel-fuse',
    FUSE,
  ],
  { cwd: ROOT, stdio: 'inherit' }
);

step('完成');
console.log('  产物：' + target);
console.log('  大小：' + (fs.statSync(target).size / 1048576).toFixed(1) + ' MB（含完整 Node 运行时）');
console.log('  双击即可运行，配置与 data/ 目录会生成在 exe 旁边。\n');
