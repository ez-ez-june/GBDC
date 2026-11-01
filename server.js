import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeDocs } from "./merge.js";
import { seed } from "./seed.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "itinerary.json");
const authFile = path.join(dataDir, "auth.json");
const port = Number(process.env.PORT) || 8787;
const sessions = new Map();
const clients = new Set();
const attempts = new Map();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
};

function lanUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(temporary, file);
  } catch {
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
}

function loadDoc() {
  if (!fs.existsSync(dataFile)) writeJson(dataFile, seed);
  return readJson(dataFile);
}

function saveDoc(doc) {
  writeJson(dataFile, doc);
  return doc;
}

function authRecord() {
  if (!fs.existsSync(authFile)) return null;
  return readJson(authFile);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function sessionUser(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid || !sessions.has(sid)) return null;
  return sid;
}

function tooManyAttempts(ip) {
  const bucket = attempts.get(ip);
  if (!bucket) return false;
  if (Date.now() > bucket.until) {
    attempts.delete(ip);
    return false;
  }
  return bucket.count >= 8;
}

function noteFailure(ip) {
  const bucket = attempts.get(ip) || { count: 0, until: Date.now() + 10 * 60 * 1000 };
  bucket.count += 1;
  attempts.set(ip, bucket);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("bad json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

function setSession(res, sid) {
  res.setHeader("Set-Cookie", `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}

function broadcast() {
  const message = `data: ${JSON.stringify({ ok: true })}\n\n`;
  for (const client of clients) client.write(message);
}

function createSession(res) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, Date.now());
  setSession(res, sid);
}

function requireUser(req, res) {
  if (sessionUser(req)) return true;
  send(res, 401, { error: "로그인이 필요합니다." });
  return false;
}

function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const file = path.join(publicDir, decoded === "/" ? "index.html" : decoded);
  const relative = path.relative(publicDir, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    send(res, 403, "forbidden");
    return;
  }
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    send(res, 404, "not found");
    return;
  }
  const extension = path.extname(target);
  res.writeHead(200, {
    "Content-Type": types[extension] || "application/octet-stream",
    "Cache-Control": extension === ".html" || extension === ".js" || extension === ".css" ? "no-cache" : "public, max-age=86400",
  });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;
  try {
    if (pathname === "/api/status" && req.method === "GET") {
      send(res, 200, { setup: Boolean(authRecord()), authenticated: Boolean(sessionUser(req)) });
      return;
    }

    if (pathname === "/api/setup" && req.method === "POST") {
      if (authRecord()) {
        send(res, 409, { error: "비밀번호가 이미 있습니다." });
        return;
      }
      const body = await readBody(req);
      const password = String(body.password || "");
      if (password.length < 4) {
        send(res, 400, { error: "비밀번호는 4자 이상으로 정합니다." });
        return;
      }
      const salt = crypto.randomBytes(16).toString("hex");
      writeJson(authFile, { salt, hash: hashPassword(password, salt) });
      createSession(res);
      send(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "local";
      if (tooManyAttempts(ip)) {
        send(res, 429, { error: "시도가 많습니다. 10분 뒤에 다시 입력합니다." });
        return;
      }
      const record = authRecord();
      if (!record) {
        send(res, 409, { error: "먼저 비밀번호를 정합니다." });
        return;
      }
      const body = await readBody(req);
      const actual = hashPassword(String(body.password || ""), record.salt);
      const expected = Buffer.from(record.hash, "hex");
      const given = Buffer.from(actual, "hex");
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        noteFailure(ip);
        send(res, 401, { error: "비밀번호가 다릅니다." });
        return;
      }
      attempts.delete(ip);
      createSession(res);
      send(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      const sid = sessionUser(req);
      if (sid) sessions.delete(sid);
      res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
      send(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/password" && req.method === "POST") {
      if (!requireUser(req, res)) return;
      const record = authRecord();
      const body = await readBody(req);
      const actual = hashPassword(String(body.current || ""), record.salt);
      const expected = Buffer.from(record.hash, "hex");
      const given = Buffer.from(actual, "hex");
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        send(res, 401, { error: "현재 비밀번호가 다릅니다." });
        return;
      }
      const next = String(body.next || "");
      if (next.length < 4) {
        send(res, 400, { error: "새 비밀번호는 4자 이상으로 정합니다." });
        return;
      }
      const salt = crypto.randomBytes(16).toString("hex");
      writeJson(authFile, { salt, hash: hashPassword(next, salt) });
      send(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/meta" && req.method === "GET") {
      if (!requireUser(req, res)) return;
      send(res, 200, { lanUrls: lanUrls(), port });
      return;
    }

    if (pathname === "/api/itinerary" && req.method === "GET") {
      if (!requireUser(req, res)) return;
      send(res, 200, loadDoc());
      return;
    }

    if (pathname === "/api/itinerary" && req.method === "PUT") {
      if (!requireUser(req, res)) return;
      const body = await readBody(req);
      const incoming = body.doc;
      if (!incoming || !Array.isArray(incoming.days)) {
        send(res, 400, { error: "일정 형식이 아닙니다." });
        return;
      }
      const next = body.mode === "replace"
        ? { ...incoming, updatedAt: new Date().toISOString() }
        : mergeDocs(loadDoc(), incoming);
      saveDoc(next);
      broadcast();
      send(res, 200, next);
      return;
    }

    if (pathname === "/api/events" && req.method === "GET") {
      if (!sessionUser(req)) {
        send(res, 401, { error: "로그인이 필요합니다." });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res, pathname);
      return;
    }

    send(res, 405, { error: "지원하지 않는 요청입니다." });
  } catch (error) {
    send(res, error.status || 500, { error: "요청을 처리하지 못했습니다." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`일정 앱 http://localhost:${port}`);
  for (const url of lanUrls()) console.log(`같은 와이파이 ${url}`);
});
