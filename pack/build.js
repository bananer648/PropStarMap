// ============================================================
// 命题星图（PropStarMap）构建脚本（Node 版，UTF-8 安全）
// 步骤：复制站点 → 生成 SEA blob → 复制 node.exe → postject 注入 → 命题星图.exe
// 运行：node build.js
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PACK = __dirname;
const ROOT = path.dirname(PACK);          // 发布版根目录
const SITE = path.join(ROOT, "site");
const OUT = path.join(ROOT, "命题星图.exe");
const WORK_EXE = path.join(PACK, "PropStarMap-node.exe");
const BLOB = path.join(PACK, "sea-prep.blob");
const CONFIG = path.join(PACK, "sea-config.json");

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: "inherit", shell: false }, opts));
  if (r.status !== 0) {
    throw new Error(cmd + " " + args.join(" ") + " 退出码 " + r.status);
  }
}
function log(msg) { console.log(msg); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

// ---------- 1. 复制站点 ----------
log("== 1/5 复制站点文件 ==");
rmrf(SITE);
fs.mkdirSync(SITE, { recursive: true });
const SKIP = new Set(["pack", "site", ".git"]);   // .git 绝不进站点
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (d.isDirectory() && !SKIP.has(d.name)) {
    fs.cpSync(path.join(ROOT, d.name), path.join(SITE, d.name), { recursive: true });
  }
}
for (const f of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (f.isFile() && !/\.(js|ps1|exe)$/i.test(f.name)) {
    fs.copyFileSync(path.join(ROOT, f.name), path.join(SITE, f.name));
  }
}
// 修正：复制站点后，重新生成 sea-config（lib/fonts 必须嵌入，KaTeX 渲染依赖）
const assetDir = path.join(SITE, "lib", "fonts");
const fontFiles = [];
if (fs.existsSync(assetDir)) {
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else fontFiles.push(p);
    });
  })(assetDir);
}
log("  字体文件数: " + fontFiles.length);

// 生成 sea-config.json（包含全部字体）
function buildSeaConfig() {
  const assets = {
    "site/index.html": "../site/index.html",
    "site/node.html": "../site/node.html",
    "site/README.md": "../site/README.md",
    "site/css/style.css": "../site/css/style.css",
    "site/js/app.js": "../site/js/app.js",
    "site/js/notes-store.js": "../site/js/notes-store.js",
    "site/data/manifest.js": "../site/data/manifest.js",
    "site/data/topology.js": "../site/data/topology.js",
    "site/data/analysis.js": "../site/data/analysis.js",
    "site/data/algebra.js": "../site/data/algebra.js",
    "site/data/SCHEMA.md": "../site/data/SCHEMA.md",
    "site/lib/cytoscape.min.js": "../site/lib/cytoscape.min.js",
    "site/lib/dagre.min.js": "../site/lib/dagre.min.js",
    "site/lib/cytoscape-dagre.js": "../site/lib/cytoscape-dagre.js",
    "site/lib/cose-base.js": "../site/lib/cose-base.js",
    "site/lib/cytoscape-fcose.js": "../site/lib/cytoscape-fcose.js",
    "site/lib/cytoscape-popper.js": "../site/lib/cytoscape-popper.js",
    "site/lib/katex.min.js": "../site/lib/katex.min.js",
    "site/lib/auto-render.min.js": "../site/lib/auto-render.min.js",
    "site/lib/katex.min.css": "../site/lib/katex.min.css"
  };
  fontFiles.forEach(function (p) {
    const rel = path.relative(SITE, p).replace(/\\/g, "/");
    assets["site/" + rel] = "../site/" + rel;
  });
  return {
    main: "server.js",
    output: "sea-prep.blob",
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: assets
  };
}
fs.writeFileSync(CONFIG, JSON.stringify(buildSeaConfig(), null, 2), "utf8");
log("  sea-config.json 已重新生成（含 " + Object.keys(JSON.parse(fs.readFileSync(CONFIG, "utf8")).assets).length + " 个资源）");

// 资源清单检查
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const missing = [];
Object.keys(cfg.assets).forEach(function (key) {
  const p = path.join(PACK, cfg.assets[key]);
  if (!fs.existsSync(p)) missing.push(cfg.assets[key]);
});
if (missing.length) {
  missing.forEach(function (m) { console.error("  缺失: " + m); });
  throw new Error("资源清单不完整");
}
log("  资源清单: " + Object.keys(cfg.assets).length + " 个文件全部存在");

// ---------- 2. 生成 SEA blob ----------
log("== 2/5 生成 SEA blob ==");
rmrf(BLOB);
const nodeBin = process.execPath;
run(nodeBin, ["--experimental-sea-config", CONFIG], { cwd: PACK });
if (!fs.existsSync(BLOB)) throw new Error("sea-prep.blob 未生成");

// ---------- 3. 复制 node.exe ----------
log("== 3/5 复制 node.exe ==");
rmrf(WORK_EXE);
fs.copyFileSync(nodeBin, WORK_EXE);

// ---------- 4. postject 注入 ----------
log("== 4/5 注入 blob ==");
// 优先用本地 node_modules 里的 postject（避免 npx 网络/缓存问题）
let postjectBin = path.join(PACK, "node_modules", ".bin", process.platform === "win32" ? "postject.cmd" : "postject");
if (!fs.existsSync(postjectBin)) {
  postjectBin = process.platform === "win32" ? "npx.cmd" : "npx";
  run(postjectBin, [
    "-y", "postject", WORK_EXE, "NODE_SEA_BLOB", BLOB,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
  ], { cwd: PACK, shell: true });
} else {
  run(postjectBin, [
    WORK_EXE, "NODE_SEA_BLOB", BLOB,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
  ], { cwd: PACK, shell: true });
}

// ---------- 5. 输出 ----------
log("== 5/5 输出 命题星图.exe ==");
rmrf(OUT);
fs.copyFileSync(WORK_EXE, OUT);
rmrf(WORK_EXE);
const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
log("  完成: " + OUT);
log("  大小: " + mb + " MB");
log("  双击「命题星图.exe」→ 自动打开浏览器；关闭控制台窗口即停止服务。");
