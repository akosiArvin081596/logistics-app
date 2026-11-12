// A fake Triumph SFTP drop for the runners (and the browser harness): ssh2's own Server on
// 127.0.0.1, so the transport (lib/triumph-transfer.js) talks the real protocol to nothing
// outside this machine. Made-up keys and folders only; nothing here knows Triumph's own.
//
//   const fake = await startFakeTriumph({ hostKey, clientKey, user: "made-up-user", folders: ["/made-up/submit"] })
//   ... connect with TRIUMPH_HOST=127.0.0.1, TRIUMPH_PORT=fake.port ...
//   fake.files (path -> Buffer), fake.ops (every SFTP request), fake.auth (every sign-in try),
//   fake.writeOps() (the requests that would change anything there), await fake.close()
//
// It accepts only `clientKey`'s public half, for `user`, by the methods in `methods`
// (["publickey"] unless a runner offers others, to see that the client never answers them).
// Files live in memory. Removing, renaming, making folders and setting attributes are
// refused and recorded: the transport has no way to ask for them, and a runner proves it.
// `faults` scripts a failure: { openStatus(path, flags), dropOnWrite(path, n), sizeFor(path),
// statStatus(path), holdSubsystem() }, each answering null for "as normal"; holdSubsystem()
// true signs the client in and never answers its request for the file channel.
// fake.open() counts the connections still open.
"use strict";

const path = require("path");
const { Server, utils: { parseKey, sftp: { OPEN_MODE, STATUS_CODE } } } = require("ssh2");

const WRITE_OPS = new Set(["WRITE", "REMOVE", "RENAME", "MKDIR", "RMDIR", "SETSTAT", "FSETSTAT", "SYMLINK"]);

function startFakeTriumph({ hostKey, clientKey, user = "made-up-user", folders = [], methods = ["publickey"], faults = {}, files = new Map() } = {}) {
	const allowed = parseKey(clientKey);
	if (allowed instanceof Error) throw allowed;
	const dirs = new Set(folders.map((f) => path.posix.normalize(f)));
	const ops = [];
	const auth = [];
	const fault = (name, ...args) => (typeof faults[name] === "function" ? faults[name](...args) : null);
	const attrs = (size) => ({ mode: 0o100600, uid: 0, gid: 0, size, atime: 0, mtime: 1762905600 });
	const dirAttrs = () => ({ mode: 0o40700, uid: 0, gid: 0, size: 0, atime: 0, mtime: 1762905600 });

	const clients = new Set();
	const server = new Server({ hostKeys: [hostKey] }, (client) => {
		clients.add(client);
		client.on("close", () => clients.delete(client));
		client.on("error", () => {});
		client.on("authentication", (ctx) => {
			auth.push({ method: ctx.method, user: ctx.username });
			if (!methods.includes(ctx.method)) return ctx.reject(methods.filter((m) => m !== "none"));
			if (ctx.method === "password") return ctx.reject();
			if (ctx.method === "keyboard-interactive") {
				return ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
					auth.push({ method: "keyboard-interactive-answer", answered: Array.isArray(answers) && answers.length > 0 });
					ctx.reject();
				});
			}
			if (ctx.method !== "publickey" || ctx.username !== user) return ctx.reject();
			if (ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject();
			if (ctx.signature && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
			return ctx.accept();
		});
		client.on("ready", () => {
			client.on("session", (accept) => {
				const session = accept();
				session.on("sftp", (acceptSftp) => {
					if (fault("holdSubsystem")) return;
					const sftp = acceptSftp();
					const handles = new Map();
					let next = 0;
					const handleFor = (h) => (h.length === 4 ? handles.get(h.readUInt32BE(0)) : undefined);
					const newHandle = (value) => {
						const h = Buffer.alloc(4);
						h.writeUInt32BE(next, 0);
						handles.set(next++, value);
						return h;
					};
					const note = (op, extra = {}) => ops.push({ op, ...extra });
					sftp.on("OPEN", (reqid, filename, flags) => {
						const p = path.posix.normalize(filename);
						const writing = Boolean(flags & OPEN_MODE.WRITE);
						note("OPEN", { path: p, write: writing, exclusive: Boolean(flags & OPEN_MODE.EXCL) });
						const scripted = fault("openStatus", p, flags);
						if (scripted !== null && scripted !== undefined) return sftp.status(reqid, scripted);
						if (!dirs.has(path.posix.dirname(p))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
						if (writing) {
							if ((flags & OPEN_MODE.EXCL) && files.has(p)) return sftp.status(reqid, STATUS_CODE.FAILURE);
							if ((flags & OPEN_MODE.TRUNC) || !files.has(p)) files.set(p, Buffer.alloc(0));
							return sftp.handle(reqid, newHandle({ path: p, writes: 0 }));
						}
						if (!files.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
						return sftp.handle(reqid, newHandle({ path: p, reading: true }));
					});
					sftp.on("WRITE", (reqid, handle, offset, data) => {
						const h = handleFor(handle);
						note("WRITE", { path: h && h.path, bytes: data.length });
						if (!h || h.reading) return sftp.status(reqid, STATUS_CODE.FAILURE);
						h.writes++;
						const cur = files.get(h.path) || Buffer.alloc(0);
						const out = Buffer.alloc(Math.max(cur.length, offset + data.length));
						cur.copy(out);
						data.copy(out, offset);
						files.set(h.path, out);
						if (fault("dropOnWrite", h.path, h.writes)) return client.end();
						return sftp.status(reqid, STATUS_CODE.OK);
					});
					sftp.on("READ", (reqid, handle, offset, length) => {
						const h = handleFor(handle);
						note("READ", { path: h && h.path });
						const buf = h ? files.get(h.path) : null;
						if (!buf) return sftp.status(reqid, STATUS_CODE.FAILURE);
						if (offset >= buf.length) return sftp.status(reqid, STATUS_CODE.EOF);
						return sftp.data(reqid, buf.subarray(offset, Math.min(buf.length, offset + length)));
					});
					sftp.on("CLOSE", (reqid, handle) => {
						const h = handleFor(handle);
						note("CLOSE", { path: h && h.path });
						if (handle.length === 4) handles.delete(handle.readUInt32BE(0));
						return sftp.status(reqid, h ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
					});
					const stat = (op) => (reqid, p0) => {
						const p = path.posix.normalize(p0);
						note(op, { path: p });
						const scripted = fault("statStatus", p);
						if (scripted !== null && scripted !== undefined) return sftp.status(reqid, scripted);
						if (dirs.has(p)) return sftp.attrs(reqid, dirAttrs());
						if (!files.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
						const lie = fault("sizeFor", p);
						return sftp.attrs(reqid, attrs(lie !== null && lie !== undefined ? lie : files.get(p).length));
					};
					sftp.on("STAT", stat("STAT"));
					sftp.on("LSTAT", stat("LSTAT"));
					sftp.on("FSTAT", (reqid, handle) => {
						const h = handleFor(handle);
						note("FSTAT", { path: h && h.path });
						if (!h || !files.has(h.path)) return sftp.status(reqid, STATUS_CODE.FAILURE);
						return sftp.attrs(reqid, attrs(files.get(h.path).length));
					});
					sftp.on("OPENDIR", (reqid, p0) => {
						const p = path.posix.normalize(p0);
						note("OPENDIR", { path: p });
						if (!dirs.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
						return sftp.handle(reqid, newHandle({ dir: p, listed: false }));
					});
					sftp.on("READDIR", (reqid, handle) => {
						const h = handleFor(handle);
						note("READDIR", { path: h && h.dir });
						if (!h || !h.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
						if (h.listed) return sftp.status(reqid, STATUS_CODE.EOF);
						h.listed = true;
						const names = [...files.keys()].filter((f) => path.posix.dirname(f) === h.dir)
							.map((f) => ({ filename: path.posix.basename(f), longname: path.posix.basename(f), attrs: attrs(files.get(f).length) }));
						if (!names.length) return sftp.status(reqid, STATUS_CODE.EOF);
						return sftp.name(reqid, names);
					});
					sftp.on("REALPATH", (reqid, p0) => {
						note("REALPATH", { path: p0 });
						return sftp.name(reqid, [{ filename: path.posix.normalize(p0 || "/"), longname: "", attrs: dirAttrs() }]);
					});
					for (const op of ["REMOVE", "RENAME", "MKDIR", "RMDIR", "SETSTAT", "FSETSTAT", "SYMLINK", "READLINK"]) {
						sftp.on(op, (reqid, p0) => {
							note(op, { path: Buffer.isBuffer(p0) ? "(handle)" : p0 });
							return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
						});
					}
				});
			});
		});
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve({
				host: "127.0.0.1",
				port: server.address().port,
				files,
				ops,
				auth,
				writeOps: () => ops.filter((o) => WRITE_OPS.has(o.op) || (o.op === "OPEN" && o.write)),
				open: () => clients.size,
				close: () => new Promise((done) => {
					for (const c of clients) {
						try {
							c.end();
						} catch {
							// already gone
						}
					}
					server.close(() => done());
				}),
			});
		});
	});
}

// The fingerprint ssh-keygen -l prints for a private key's public half: "SHA256:<base64>".
function fingerprintOfKey(privateKey) {
	const k = parseKey(privateKey);
	return `SHA256:${require("crypto").createHash("sha256").update(k.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

module.exports = { startFakeTriumph, fingerprintOfKey, WRITE_OPS };
