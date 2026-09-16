// ============================================================
// MathKG 本地服务器（用于打包 exe，也兼容直接 node 运行）
// 双击 exe：启动本地静态服务 → 自动在默认浏览器打开。
// 数据（笔记/布局/编号/导入节点等）由页面自行存 localStorage，
// 服务器只负责提供静态文件，不存储任何数据。
// ============================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ---------- 检测 SEA（打包后的单文件 exe）环境 ----------
let sea = null;
let isSea = false;
try {
  sea = require("node:sea");
  isSea = !!(sea && typeof sea.isSea === "function" && sea.isSea());
} catch (e) { /* 普通 node 运行 */ }

// 磁盘模式：站点目录 = 本脚本所在目录的 site/
const SITE_DIR = path.join(__dirname, "site");
// SEA 模式：资源键前缀（sea-config.json 中 assets 配置的虚拟路径）
const SEA_PREFIX = "site/";
// SEA 模式下，exe 所在目录（若用户解压时保留了网页版文件夹，可作为磁盘回退）
const EXE_DIR = isSea ? path.dirname(process.execPath) : __dirname;

// ---------- 读取资源（SEA 嵌入优先，磁盘兜底） ----------
function readAsset(relPath) {
  if (isSea) {
    try {
      const key = SEA_PREFIX + relPath;
      let raw = null;
      try {
        raw = sea.getRawAsset ? sea.getRawAsset(key) : null;
      } catch (e2) { raw = null; }
      if (raw === null || raw === undefined) {
        const ab = sea.getAsset(key);
        raw = ab === undefined ? null : ab;
      }
      if (raw) {
        // getRawAsset / getAsset 可能返回 ArrayBuffer 或 Uint8Array，
        // 统一转成 Buffer（res.end 只接受 string/Buffer/Uint8Array）
        if (raw instanceof ArrayBuffer) raw = Buffer.from(raw);
        else if (!Buffer.isBuffer(raw) && typeof raw !== "string") raw = Buffer.from(raw);
        return raw;
      }
    } catch (e) { /* 未嵌入的资源回落到磁盘 */ }
  }
  // 磁盘回退 1：exe/脚本所在目录（site/ 子目录）
  try {
    const p = path.join(SITE_DIR, relPath);
    if (p.startsWith(SITE_DIR)) {
      const d = fs.readFileSync(p);
      if (d) return d;
    }
  } catch (e) { /* 继续下一级回退 */ }
  // 磁盘回退 2：exe 同级的「网页版/」文件夹（发布包布局）
  try {
    const webDir = path.join(EXE_DIR, "网页版");
    const p = path.join(webDir, relPath);
    if (p.startsWith(webDir)) {
      const d = fs.readFileSync(p);
      if (d) return d;
    }
  } catch (e) { /* 无此文件 */ }
  return null;
}

// ---------- MIME ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8"
};

function resolvePath(urlPath) {
  let p = decodeURIComponent((urlPath || "/").split("?")[0].split("#")[0]);
  if (p === "/") p = "/index.html";
  let rel = p.replace(/^\/+/, "").replace(/\\/g, "/");
  if (rel.split("/").indexOf("..") >= 0) return null;   // 防目录穿越
  return rel;
}

// ---------- 启动 ----------
const server = http.createServer(function (req, res) {
  // favicon：浏览器会自动请求，找不到就 204 避免刷 404
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const rel = resolvePath(req.url);
  if (rel === null) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  let data = readAsset(rel);
  if (data === null && rel.indexOf("/") < 0 && rel.indexOf(".") < 0) {
    data = readAsset(rel + ".html");       // 无扩展名兜底
  }
  if (data === null) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><h2>404</h2><p>找不到 " + rel + "</p>");
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  res.end(data);
});

// 只监听本机回环地址，避免局域网暴露
const HOST = "127.0.0.1";
const PREFERRED = 8765;

function openBrowser(url) {
  try {
    // Windows：cmd /c start "" <url>（不捕获输出，避免管道限制）
    const p = spawn("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
    p.on("error", function () { /* 忽略 */ });
    p.unref();
  } catch (e) { /* 忽略：用户可手动复制地址 */ }
}

function listen(port) {
  server.once("error", function (err) {
    if (err.code === "EADDRINUSE" && port < 8800) {
      listen(port + 1);
    } else if (port >= 8800) {
      // 常用端口都被占：随机端口
      server.listen(0, HOST, function () {
        const p = server.address().port;
        const url = "http://" + HOST + ":" + p + "/";
        openBrowser(url);
      });
    } else {
      console.error("启动失败:", err.message);
    }
  });
  server.listen(port, HOST, function () {
    const p = server.address().port;
    const url = "http://" + HOST + ":" + p + "/";
    openBrowser(url);
  });
}

process.title = "命题星图 PropStarMap（关闭本窗口即停止服务）";
console.log("命题星图 PropStarMap 已启动");
listen(PREFERRED);
