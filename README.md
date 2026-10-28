# Kindle Dock · 投书台

一个跑在你自己电脑上的小网页：**把书拖进浏览器 → 直接 SFTP 写进 Kindle**。
不需要 FileZilla、不需要 calibre-web、不需要云端，全程只在你家 WiFi 内。

> A tiny self-hosted web app that pushes ebooks to a jailbroken Kindle over SFTP.
> Drag & drop in the browser — no Calibre, no cloud, no USB. Docs are in Chinese.

```
浏览器拖拽  →  本机 HTTP(8765)  →  SFTP(2222)  →  /mnt/us/documents
```

## 为什么这么做

上一份手册里的 SFTP 方案要手动开 FileZilla、填四个字段、拖文件、再回 Kindle 刷新目录。
这个页面把那套流程固化成一次配置 + 一个拖动动作，并且额外提供：

- 连接自检（点一次就知道是端口没开、IP 变了、还是认证被拒）
- 上传队列：拖进来的书**立刻全部入队可见**，串行上传，每本都能单独取消（正在传的也能中断，且不留残缺文件）
- 上传进度条（大 PDF 也能看到百分比）
- 「书架」页查看/下载/删除 Kindle 上的书
- 免装 FileZilla，也不用记 `sftp://` 前缀和 2222 端口

## 启动

双击 **`启动.bat`**，或者命令行：

```bash
cd kindle-dock
npm install        # 只需第一次
npm start
```

然后浏览器打开 <http://127.0.0.1:8765>

## 打包成 exe（便携版）

```bash
npm install          # 第一次
npm run exe
```

产物：`dist/Kindle投书.exe`（约 84 MB）+ `dist/data/config.json` + `dist/使用说明.txt`

双击 exe 即用，**目标电脑不需要装 Node**。整个 `dist/` 文件夹拷到任何 Windows x64 上都能跑。

**原理**（Node SEA，Single Executable Application）：

1. `esbuild` 把 `server.js` 和 `ssh2` 打包成单个 `build/app.cjs`
2. `node --experimental-sea-config` 把这坨 JS 和 `public/index.html` 生成为一段 blob
3. 复制一份 `node.exe`，用 `postject` 把 blob 注入进去

所以体积大是因为**里面塞了一整个 Node 运行时**——换来的是零依赖、单文件、启动 ~200ms。代码里通过 `require('node:sea').isSea()` 判断运行模式：SEA 下网页从内嵌资源读，`data/` 目录定位到 exe 所在目录而非 `__dirname`。

**注意**：

- exe 未签名，首次运行 Windows 可能弹「已阻止」→ 选「更多信息 → 仍要运行」
- 会自动挑端口：8765 被占就顺延 8766、8767…
- 如果已经有一个实例在跑，再双击不会重复启动，而是直接把浏览器指到已有的那个
- 想调代码却不想每次重打包：用 `npm start` 跑源码版，改完刷新浏览器即可

## 第一次使用：三步

### 1. 在 Kindle 上开 SSH 服务器

KOReader → 顶部菜单 → **工具 → 网络 → SSH 服务器**
勾选 **「登录无需密码 Login without password (DANGEROUS)」**，再勾 **「SSH 服务器」**。
弹窗会显示 `192.168.x.x:2222`，把这个 IP 记下来。

> 新版 KOReader 可能把入口收在 `工具 → 更多工具 → SSH 服务器`。

### 2. 在页面上填连接信息

点右上角 **设置**：

| 字段 | 填什么 |
|---|---|
| 设备 IP | 上一步弹窗里的 IP |
| 端口 | 2222 |
| 用户名 | root |
| 登录方式 | 空密码（推荐） |
| 远程目录 | /mnt/us/documents |

点 **测试连接**。成功会显示「连接成功 · xx ms · 目录内有 N 个条目」。

### 3. 拖书

回到「上传」，把 epub / pdf / mobi 拖进卡片。传完去 KOReader 的**文件浏览器刷新目录**，或者直接点「书架」页查看。

## 常见问题

**测试连接报「端口拒绝连接」**
Kindle 上的 KOReader 没开 SSH 服务器，或者 KOReader 被切到后台了。重开一次。

**报「认证被拒」**
没勾「登录无需密码」。**注意：勾完必须把「SSH 服务器」关掉再重新打开**，开关不重启不生效。
如果错误里显示「服务端只接受 publickey」，说明这台设备禁用了密码登录，只能走密钥（见下）。

**报「连不上这台设备」**
- Kindle 熄屏了（熄屏会断 WiFi），点亮屏幕再试
- 电脑和 Kindle 不在同一个 WiFi（手机热点也行，但要连同一个）
- 路由器开了「AP 隔离」，同 WiFi 也互相不通
- Kindle 的 IP 变了 → 在路由器里给它的 MAC 做静态绑定，一劳永逸

**上传到一半失败**
Kindle 休眠断网。传输时把屏幕亮着，或插着 USB 供电（别插电脑，插充电头）。

**传完了 KOReader 里看不到**
文件浏览器 → 菜单 → **刷新目录 Refresh directory**。

**书挪走了，阅读进度丢了**
KOReader 把进度存在书旁边的 `书名.sdr` 文件夹里。用外部工具移动/改名时要把 `.sdr` 一起带走。这个页面只做单向投递，不动已有文件。

## 安全说明

- 服务默认只绑 `127.0.0.1`，局域网内其他设备访问不到
- **配置文件 `data/config.json` 里密码是明文**。这是本机工具，别把这个目录发给别人
- Kindle 那边勾了「登录无需密码」等于谁都能进——只在家里内网用，传完把 SSH 服务器关掉
- 想让服务对局域网开放：`HOST=0.0.0.0 npm start`（不建议，除非你清楚在做什么）

## 目录结构

```
kindle-dock/
├─ server.js          服务端：HTTP 路由 + SFTP 流式传输
├─ public/index.html  前端：单文件，无构建
├─ data/config.json   自动生成，存连接信息
├─ 启动.bat           Windows 双击启动（源码版）
├─ tools/build-exe.js 一键打包 exe 的脚本（npm run exe）
├─ test/              mock SFTP + 端到端测试（npm test）
├─ dist/              exe 产物目录
└─ package.json       运行时只有一个依赖：ssh2
```

## 实现要点

- 上传走 `PUT /api/upload?name=<文件名>`，请求体就是文件本身，**服务端用流直接写进 SFTP**，不落临时文件、不吃内存，几百 MB 的 PDF 也不会炸
- 不用 multer/busboy：省掉整个 multipart 解析依赖
- 认证按 `publickey → password(可为空) → keyboard-interactive` 顺序尝试，覆盖 Kindle 上 dropbear 的几种形态
- 所有 SFTP 连接都是「一次操作用完即断」，不保持长连接，避免 Kindle 休眠后连接僵死

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 读配置 |
| POST | `/api/config` | 存配置 |
| POST | `/api/test` | 连接自检 |
| GET | `/api/list?dir=` | 列目录 |
| PUT | `/api/upload?name=&dir=` | 上传（请求体为文件二进制） |
| GET | `/api/file?path=` | 下载 |
| DELETE | `/api/file?path=` | 删除 |

## 协议

GPL-3.0，见 [LICENSE](LICENSE)。

本项目只负责**传输文件**，不涉及任何书籍的解密、破解或内容分发。请仅用于传输你有权使用的文件。

## 致谢

- [KOReader](https://github.com/koreader/koreader) —— Kindle 上那个让一切成为可能的阅读器
- [ssh2](https://github.com/mscdex/ssh2) —— 纯 JS 的 SSH/SFTP 实现，本项目唯一运行时依赖
