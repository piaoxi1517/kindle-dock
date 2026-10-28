'use strict';
/*
 * 极简 SFTP 服务器（仅本地自测用，模拟 Kindle 上的 dropbear + sftp-server）
 * 用法：node test/mock-sftp.js <port> <rootDir>
 */

const { Server, utils } = require('ssh2');
const fs = require('fs');
const path = require('path');

function attrs(st) {
  return {
    mode: st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function start(port, rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const real = (p) => path.join(rootDir, path.normalize(p || '/').replace(/^([/\\])+/, ''));
  const handles = new Map();
  let hid = 0;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (['none', 'password', 'keyboard-interactive', 'publickey'].includes(ctx.method)) ctx.accept();
      else ctx.reject();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (accept) => {
          const sftp = accept();

          sftp.on('REALPATH', (reqid, p) => {
            sftp.name(reqid, [{ filename: path.posix.normalize(p || '/'), longname: p, attrs: {} }]);
          });

          sftp.on('OPEN', (reqid, filename, flags) => {
            const writable = (flags & 0x02) !== 0;
            fs.open(real(filename), writable ? 'w' : 'r', (err, fd) => {
              if (err) return sftp.status(reqid, 2);
              const h = Buffer.from('h' + ++hid);
              handles.set(h.toString(), { type: 'file', fd });
              sftp.handle(reqid, h);
            });
          });

          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const ent = handles.get(handle.toString());
            if (!ent) return sftp.status(reqid, 4);
            fs.write(ent.fd, data, 0, data.length, offset, (err) =>
              sftp.status(reqid, err ? 4 : 0)
            );
          });

          sftp.on('READ', (reqid, handle, offset, length) => {
            const ent = handles.get(handle.toString());
            if (!ent) return sftp.status(reqid, 4);
            const b = Buffer.alloc(length);
            fs.read(ent.fd, b, 0, length, offset, (err, n) => {
              if (err) return sftp.status(reqid, 4);
              if (!n) return sftp.status(reqid, 1);
              sftp.data(reqid, b.subarray(0, n));
            });
          });

          sftp.on('CLOSE', (reqid, handle) => {
            const ent = handles.get(handle.toString());
            if (ent && ent.fd != null) fs.close(ent.fd, () => {});
            handles.delete(handle.toString());
            sftp.status(reqid, 0);
          });

          sftp.on('MKDIR', (reqid, dir) => {
            fs.mkdir(real(dir), (err) =>
              sftp.status(reqid, err && err.code !== 'EEXIST' ? 4 : 0)
            );
          });

          sftp.on('OPENDIR', (reqid, dir) => {
            fs.readdir(real(dir), (err, names) => {
              if (err) return sftp.status(reqid, 2);
              const h = Buffer.from('d' + ++hid);
              handles.set(h.toString(), { type: 'dir', dir: real(dir), names });
              sftp.handle(reqid, h);
            });
          });

          sftp.on('READDIR', (reqid, handle) => {
            const ent = handles.get(handle.toString());
            if (!ent) return sftp.status(reqid, 4);
            if (!ent.names.length) return sftp.status(reqid, 1);
            const batch = ent.names.splice(0);
            sftp.name(
              reqid,
              batch.map((n) => {
                let st;
                try { st = fs.statSync(path.join(ent.dir, n)); } catch { st = { mode: 0o100644, size: 0, atimeMs: 0, mtimeMs: 0 }; }
                return { filename: n, longname: n, attrs: attrs(st) };
              })
            );
          });

          const statHandler = (reqid, target) => {
            fs.stat(real(target), (err, st) => {
              if (err) return sftp.status(reqid, 2);
              sftp.attrs(reqid, attrs(st));
            });
          };
          sftp.on('STAT', statHandler);
          sftp.on('LSTAT', statHandler);

          sftp.on('REMOVE', (reqid, target) => {
            fs.unlink(real(target), (err) => sftp.status(reqid, err ? 4 : 0));
          });

          sftp.on('RMDIR', (reqid, target) => {
            fs.rmdir(real(target), (err) => sftp.status(reqid, err ? 4 : 0));
          });

          sftp.on('RENAME', (reqid, from, to) => {
            fs.rename(real(from), real(to), (err) => sftp.status(reqid, err ? 4 : 0));
          });
        });
      });
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2] || 2223);
  const root = process.argv[3] || path.join(__dirname, 'sandbox');
  start(port, root).then(() => console.log('mock sftp listening :' + port + ' -> ' + root));
}
