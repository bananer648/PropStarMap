// ============================================================
// 命题星图（PropStarMap） - 主应用（性能优化版）
// Bananer：i ❤ CQU
// 数据加载方式：各学科 data/*.js 通过 <script> 注入并调用
// window.registerSubject(data)，数据收集在 window.__KG_REGISTRY。
//
// 本版性能要点：
//  * 筛选（学科 / 类型 / 边类型）与搜索全部改为「显隐过滤」：
//    不再 remove() 重建元素、不再重跑布局，切换瞬时完成。
//  * 星云（fcose）布局只跑一次；布局完成后在「模型坐标」里做一次
//    空间哈希加速的最小间距后处理（圆心距 >= 52，与缩放级别无关），
//    彻底消除球体叠压（屏幕坐标方案会被 cy.fit 重新缩放抵消）。
//  * 「间距」滑块：绕质心等比缩放所有球的相对位置（scale 相对布局基准）。
//  * 右键节点：菜单可「放大 / 缩小此球」（改单球大小并推开邻居）与「撤销」。
//  * 布局持久化：每学科视图的相对位置存 localStorage（含 scale 与球大小），
//    下次打开原样恢复；只有右键空白处「重新布局」才重排；Ctrl+Z 可撤销。
//  * 流动光点改为 requestAnimationFrame，且每条边的渲染曲线点
//    只在「该边可见且点还在移动」时缓存一次，缩放/拖动才失效
//    重算，空闲时几乎零开销。
//  * 搜索预建倒排索引（含 LaTeX 去控制序列后的纯文本），击键
//    防抖 180ms，命中节点加亮圈、非命中淡出。
//  * 侧栏 KaTeX 渲染按节点缓存，二次点击直接复用 DOM。
// ============================================================
(function () {
  "use strict";

  // ---------- 数据收集 ----------
  const SUBJECTS = window.KG_SUBJECTS || [];
  const subjects = {};   // id -> subject 信息
  const allNodes = {};   // id -> node（node 增加 subjectId）
  const allEdges = [];   // { id, source, target, type, label, subjectId }
  const allJoints = [];  // { id, sources[], target, label, ref, subjectId }
  const nodeIdsBySubject = {};
  const registered = window.__KG_REGISTRY || [];

  (function buildData() {
    registered.forEach(function (data) {
      const s = data.subject;
      subjects[s.id] = s;
      nodeIdsBySubject[s.id] = [];
      (data.nodes || []).forEach(function (n) {
        const node = Object.assign({}, n, { subjectId: s.id, subjectColor: s.color });
        allNodes[n.id] = node;
        nodeIdsBySubject[s.id].push(n.id);
      });
      (data.edges || []).forEach(function (e) {
        allEdges.push(Object.assign({}, e, { subjectId: s.id }));
      });
      (data.joints || []).forEach(function (j) {
        allJoints.push(Object.assign({}, j, { subjectId: s.id }));
      });
    });
  })();

  // ---------- 用户手动导入的节点（单个/批量） ----------
  // 结构：{ id, kind:'theorem', label, title, statement, proof, ref, note, manualNum }
  // 存 localStorage（键 kg-user-nodes-v1）；编号=教材节点之后追加（不打乱教材编号）。
  const USER_NODES_LS_KEY = "kg-user-nodes-v1";
  const userNodes = {           // id -> node（数组顺序即导入顺序）
    data: {},
    order: [],
    load: function () {
      try {
        const obj = JSON.parse(localStorage.getItem(USER_NODES_LS_KEY) || "null");
        if (obj && typeof obj === "object" && Array.isArray(obj.nodes)) {
          obj.nodes.forEach(function (n) {
            if (n && typeof n.id === "string" && n.id && !userNodes.data[n.id]) {
              userNodes.data[n.id] = n;
              userNodes.order.push(n.id);
            }
          });
        }
      } catch (e) { /* 损坏时忽略 */ }
    },
    save: function () {
      try {
        localStorage.setItem(USER_NODES_LS_KEY, JSON.stringify({
          nodes: userNodes.order.map(function (id) { return userNodes.data[id]; })
        }));
      } catch (e) { /* 存储满时静默 */ }
    }
  };
  userNodes.load();
  // 把用户节点注册进 allNodes（subjectId='user' 或自建学科），供侧栏/详情/编号使用
  // 注意：需在 userSubjects 注册之后进行（见下），此处仅占位，归类逻辑在 registerUserSubjects 后统一执行。
  let userNodesRegistered = false;
  function registerUserNodes() {
    if (userNodesRegistered) return;
    userNodesRegistered = true;
    userNodes.order.forEach(function (id) {
      const n = userNodes.data[id];
      const sid = (n.subjectId && subjects[n.subjectId]) ? n.subjectId : "user";
      allNodes[id] = Object.assign({}, n, { subjectId: sid });
      if (nodeIdsBySubject[sid]) nodeIdsBySubject[sid].push(id);
    });
  }

  // ---------- 自建学科（用户手动创建的学科） ----------
  // 结构：{id, label, color, ts}；存 localStorage（键 kg-user-subjects-v1）。
  // 用户节点可归属到自建学科；删除学科时其节点自动迁回「我的节点」通用分组。
  const USER_SUBJECTS_LS_KEY = "kg-user-subjects-v1";
  const userSubjects = {
    data: [],
    load: function () {
      try {
        const arr = JSON.parse(localStorage.getItem(USER_SUBJECTS_LS_KEY) || "[]");
        if (Array.isArray(arr)) {
          this.data = arr.filter(function (s) {
            return s && typeof s.id === "string" && s.id && typeof s.label === "string" && s.label;
          });
        }
      } catch (e) { /* 损坏时清空 */ }
    },
    save: function () {
      try { localStorage.setItem(USER_SUBJECTS_LS_KEY, JSON.stringify(this.data)); }
      catch (e) { /* 存储满时静默 */ }
    }
  };
  userSubjects.load();
  // 注册到全局学科表（SUBJECTS 之外的动态学科）
  userSubjects.data.forEach(function (s) {
    if (!subjects[s.id]) {
      subjects[s.id] = { id: s.id, label: s.label, color: s.color || "#9141ac", user: true };
      nodeIdsBySubject[s.id] = [];
    }
  });
  registerUserNodes();

  // ---------- 初始编号（按教材页码混排：越早出现编号越小） ----------
  // 编号规则（双阶段，保证新导入的球不打乱教材球编号）：
  //   1. 教材节点（page 为数字）：按 page 升序编号 1..N；
  //   2. 手动导入节点（kind=theorem，无 page）：排在教材节点之后，按导入顺序追加编号 N+1..。
  const initialNum = {};
  let nextUserNum = 1;                       // 手动节点的下一个可用编号
  (function computeInitialNumbers() {
    const book = [];
    const user = [];
    Object.keys(allNodes).forEach(function (id) {
      const n = allNodes[id];
      if (n.kind === "theorem") user.push(id);
      else book.push({ id: id, page: (typeof n.page === "number") ? n.page : Infinity });
    });
    book.sort(function (a, b) { return (a.page - b.page) || (a.id.localeCompare(b.id)); });
    let num = 1;
    book.forEach(function (e) { initialNum[e.id] = num++; });
    // 手动节点：优先沿用其已保存的 manualNum（保证重开页面编号稳定），再按导入顺序补
    const used = {};
    user.forEach(function (id) {
      const n = allNodes[id];
      if (typeof n.manualNum === "number" && n.manualNum >= num && !used[n.manualNum]) {
        initialNum[id] = n.manualNum;
        used[n.manualNum] = true;
      }
    });
    user.forEach(function (id) {
      if (initialNum[id] === undefined) {
        while (used[num]) num++;
        initialNum[id] = num;
        used[num] = true;
      }
    });
    let maxUsed = num;
    Object.keys(used).forEach(function (k) { if (used[k] && Number(k) > maxUsed) maxUsed = Number(k); });
    nextUserNum = maxUsed + 1;
  })();
  // 编号存储（自定义编号 + 标注显示模式），独立于布局存档
  const NUM_LS_KEY = "kg-num-v1";
  const numStore = {
    data: { labelMode: "num", customNum: {} },
    load: function () {
      try {
        const d = JSON.parse(localStorage.getItem(NUM_LS_KEY) || "null");
        if (d && typeof d === "object") {
          if (d.labelMode === "off" || d.labelMode === "num" || d.labelMode === "full") this.data.labelMode = d.labelMode;
          if (d.customNum && typeof d.customNum === "object") this.data.customNum = d.customNum;
        }
      } catch (e) { /* 损坏时用默认值 */ }
    },
    save: function () {
      try { localStorage.setItem(NUM_LS_KEY, JSON.stringify(this.data)); } catch (e) { /* 存储满时静默 */ }
    }
  };
  numStore.load();

  // ---------- 自定义边（用户手动建立的灰色虚线连接） ----------
  // 结构：{ id, source, target, ts }；存 localStorage（键 kg-custom-edges-v1），
  // 跨学科视图共享（切到合并大网也能看到）。图内以 type='custom' 灰色虚线渲染。
  const CUSTOM_EDGES_LS_KEY = "kg-custom-edges-v1";
  const customEdges = {          // id -> {id, source, target, ts}
    load: function () {
      const out = {};
      try {
        const arr = JSON.parse(localStorage.getItem(CUSTOM_EDGES_LS_KEY) || "[]");
        if (Array.isArray(arr)) {
          arr.forEach(function (e) {
            if (e && e.id && e.source && e.target && e.source !== e.target) out[e.id] = e;
          });
        }
      } catch (e) { /* 损坏时清空 */ }
      return out;
    },
    save: function () {
      try {
        const arr = Object.keys(customEdges).map(function (k) { return customEdges[k]; });
        localStorage.setItem(CUSTOM_EDGES_LS_KEY, JSON.stringify(arr));
      } catch (e) { /* 存储满时静默 */ }
    }
  };
  customEdges.data = customEdges.load();

  // ---------- 状态 ----------
  const state = {
    view: "topology",          // 当前学科视图（'all' 表示合并大网）
    showDef: true,             // 定义
    showEx: true,              // 特例
    showAux: false,
    showEquiv: true,
    showImpl: true,
    showJoint: true,
    showCustom: true,          // 自定义边（灰色虚线）默认显示
    showUser: true,            // 手动导入节点默认显示
    query: "",                 // 当前搜索词（空 = 无过滤）
    selected: null,
    scale: 1,                  // 间距缩放（相对布局基准，等比放大球间距离）
    nodeScale: {},             // nodeId -> 单球放大倍率（1 = 默认 44px）
    labelMode: numStore.data.labelMode,   // 标注模式：off | num | full
    customNum: numStore.data.customNum    // nodeId -> 自定义编号文本
  };

  // ---------- 编号工具 ----------
  function getNum(id) {
    if (state.customNum[id] !== undefined && String(state.customNum[id]).trim() !== "") {
      return String(state.customNum[id]).trim();
    }
    return initialNum[id] !== undefined ? String(initialNum[id]) : "";
  }
  // 按标注模式刷新所有球的文字（gate 门不受影响）
  function applyLabelMode() {
    cy.batch(function () {
      cy.nodes().forEach(function (nd) {
        if (nd.data("kind") === "gate") return;
        const id = nd.id();
        const num = getNum(id);
        const name = (allNodes[id] && allNodes[id].label) || "";
        let lbl = "";
        if (state.labelMode === "num") {
          lbl = num;                                   // 仅编号：数字显示在球内
        } else if (state.labelMode === "full") {
          lbl = num ? (num + " " + name) : name;       // 编号+短名：文字在球下方白底标签
        }
        nd.data("lbl", lbl);
        nd.toggleClass("lbl-full", state.labelMode === "full");
      });
    });
  }

  // ---------- 持久化（相对位置 / 间距 / 单球大小 / 撤销栈） ----------
  const LAYOUT_LS_KEY = "kg-layout-v1";   // 布局状态本地存储键（按学科视图分档）
  const layoutMemory = {                    // 内存结构：viewId::layoutKind -> { base, scale, nodeScale }
    load: function () {
      try { return JSON.parse(localStorage.getItem(LAYOUT_LS_KEY) || "null") || {}; }
      catch (e) { return {}; }
    },
    save: function () {
      try { localStorage.setItem(LAYOUT_LS_KEY, JSON.stringify(layoutMemory.data)); }
      catch (e) { /* 存储满时静默 */ }
    }
  };
  layoutMemory.data = layoutMemory.load();
  layoutMemory.armed = true;                // 持久化总开关
  const undoStack = [];         // [{view, layout, kind, snapshot}] 最近 20 次可撤销操作
  const MAX_UNDO = 20;

  function memKey(viewId, layoutKind) {
    return viewId + "::" + layoutKind;      // 每学科 × 每布局各存一份
  }
  function memFor(viewId, layoutKind) {
    const key = memKey(viewId, layoutKind);
    if (!layoutMemory.data[key]) layoutMemory.data[key] = {};
    return layoutMemory.data[key];
  }
  // 由当前（可能已缩放/拖动的）显示位置反推 scale=1 的基准位置（含 gate 菱形）
  function currentBasePositions() {
    const nodes = cy.nodes();
    const n = nodes.length;
    const base = {};
    if (!n) return base;
    let cx = 0, cyy = 0;
    const cur = [];
    nodes.forEach(function (nd) {
      const p = nd.position();
      cx += p.x; cyy += p.y;
      cur.push({ id: nd.id(), x: p.x, y: p.y });
    });
    cx /= n; cyy /= n;
    const s = state.scale || 1;
    cur.forEach(function (o) {
      base[o.id] = { x: cx + (o.x - cx) / s, y: cyy + (o.y - cyy) / s };
    });
    return base;
  }
  function snapshotNow() {
    return {
      base: currentBasePositions(),
      scale: state.scale,
      nodeScale: Object.assign({}, state.nodeScale),
      customEdges: Object.assign({}, customEdges.data),
      userNodes: { data: Object.assign({}, userNodes.data), order: userNodes.order.slice() }
    };
  }
  function pushUndo(kind, snap) {
    if (!layoutMemory.armed) return;
    undoStack.push({ view: state.view, layout: currentLayout, kind: kind, snapshot: snap || snapshotNow() });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }
  function saveLayoutMemory() {
    if (!layoutMemory.armed) return;
    const entry = memFor(state.view, currentLayout);
    entry.base = currentBasePositions();
    entry.scale = state.scale;
    entry.nodeScale = Object.assign({}, state.nodeScale);
    layoutMemory.save();
  }
  // 拖拽节点后记录快照并持久化（防抖）
  let saveMemoryTimer = null;
  function scheduleLayoutSave() {
    if (!layoutMemory.armed) return;
    if (saveMemoryTimer) clearTimeout(saveMemoryTimer);
    saveMemoryTimer = setTimeout(saveLayoutMemory, 400);
  }
  // 快照恢复：base 绕质心按 scale 放大（与「间距」滑块的语义一致）
  function applySnapshot(snap) {
    state.scale = snap.scale || 1;
    state.nodeScale = Object.assign({}, snap.nodeScale || {});
    if (snap.customEdges) {
      customEdges.data = Object.assign({}, snap.customEdges);
      customEdges.save();
      syncCustomEdges();
      refreshCustomManager();
    }
    if (snap.userNodes) {
      userNodes.data = Object.assign({}, snap.userNodes.data);
      userNodes.order = snap.userNodes.order.slice();
      userNodes.save();
      // 重建 allNodes 中的用户节点部分（保留其学科归属）
      Object.keys(allNodes).forEach(function (id) {
        if (allNodes[id] && allNodes[id].kind === "theorem") delete allNodes[id];
      });
      userNodes.order.forEach(function (id) {
        const nn = userNodes.data[id];
        const sid = (nn.subjectId && subjects[nn.subjectId]) ? nn.subjectId : "user";
        allNodes[id] = Object.assign({}, nn, { subjectId: sid });
      });
      syncUserNodes();
      applyLabelMode();
    }
    syncSlider();
    const ids = Object.keys(snap.base || {});
    if (!ids.length) return;
    let cbx = 0, cby = 0;
    ids.forEach(function (id) { cbx += snap.base[id].x; cby += snap.base[id].y; });
    cbx /= ids.length; cby /= ids.length;
    cy.batch(function () {
      ids.forEach(function (id) {
        const el = cy.getElementById(id);
        if (el.empty()) return;
        const b = snap.base[id];
        el.position({ x: cbx + (b.x - cbx) * state.scale, y: cby + (b.y - cby) * state.scale });
      });
    });
    applyStateToNodes();
    scheduleLayoutSave();
  }
  function undoLast() {
    if (!undoStack.length) return;
    // 从后往前找「当前视图 + 当前布局」最近的一次快照，不丢弃其他视图的记录
    let idx = -1;
    for (let i = undoStack.length - 1; i >= 0; i--) {
      const s = undoStack[i];
      if (s.view === state.view && s.layout === currentLayout) { idx = i; break; }
    }
    if (idx < 0) return;
    const snap = undoStack.splice(idx, 1)[0];
    applySnapshot(snap);
  }
  // 读取当前视图的已存布局（含基准位置、间距倍率、单球大小），恢复成功返回 true
  function applyStoredLayout() {
    const entry = memFor(state.view, currentLayout);
    const base = entry && (entry.base || entry.positions);
    if (!base || !Object.keys(base).length) {
      // 无存档：使用默认间距与球大小
      state.scale = 1;
      state.nodeScale = {};
      syncSlider();
      return false;
    }
    state.scale = typeof entry.scale === "number" ? entry.scale : 1;
    state.nodeScale = Object.assign({}, entry.nodeScale || {});
    const ids = Object.keys(base);
    let cbx = 0, cby = 0;
    ids.forEach(function (id) { cbx += base[id].x; cby += base[id].y; });
    cbx /= ids.length; cby /= ids.length;
    cy.batch(function () {
      ids.forEach(function (id) {
        const el = cy.getElementById(id);
        if (el.empty()) return;
        const b = base[id];
        el.position({ x: cbx + (b.x - cbx) * state.scale, y: cby + (b.y - cby) * state.scale });
      });
    });
    applyStateToNodes();
    syncSlider();
    return true;
  }
  // 「间距」滑块：等比放大所有球之间的距离（绕质心缩放）
  function applyLayoutScale(newScale) {
    newScale = Math.min(3, Math.max(1, newScale));
    const base = currentBasePositions();     // 以旧倍率反推基准
    state.scale = newScale;
    syncSlider();
    const ids = Object.keys(base);
    if (!ids.length) return;
    let cbx = 0, cby = 0;
    ids.forEach(function (id) { cbx += base[id].x; cby += base[id].y; });
    cbx /= ids.length; cby /= ids.length;
    cy.batch(function () {
      ids.forEach(function (id) {
        const el = cy.getElementById(id);
        if (el.empty()) return;
        const b = base[id];
        el.position({ x: cbx + (b.x - cbx) * state.scale, y: cby + (b.y - cby) * state.scale });
      });
    });
    scheduleLayoutSave();
  }
  function syncSlider() {
    const sl = $("layout-scale");
    if (!sl) return;
    sl.value = state.scale;
    const lbl = $("scale-val");
    if (lbl) lbl.textContent = state.scale.toFixed(2) + "×";
  }

  function applyStateToNodes() {
    cy.batch(function () {
      cy.nodes().forEach(function (nd) {
        if (nd.data("kind") === "gate") return;
        const s = state.nodeScale[nd.id()] || 1;
        const w = 44 * s;
        nd.data("w", w);
      });
    });
  }

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  // 去掉 LaTeX 定界符与控制序列，用于搜索
  function plainText(s) {
    return String(s || "")
      .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
      .replace(/\$([^$]*)\$/g, "$1")
      .replace(/\\[a-zA-Z]+/g, "")
      .replace(/[{}$\\]/g, "");
  }

  // ---------- Cytoscape 初始化 ----------
  // 笔记角标：预生成橙色圆点 SVG dataURL（所有有笔记的节点共用）
  const NOTED_DOT_SVG = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="6" fill="#ff8c00" stroke="#ffffff" stroke-width="2"/>' +
    "</svg>"
  );
  const cy = cytoscape({
    container: $("cy"),
    elements: [],
    layout: { name: "preset" },
    style: [
      {
        selector: "node",
        style: {
          // 球内文字：按标注模式显示编号/短名（默认无文字，悬停才显示短名）
          "label": "data(lbl)",
          "font-size": 10,
          "font-weight": 600,
          "color": "#333333",
          "width": "data(w)",
          "height": "data(w)",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "data(w)",
          "shape": "ellipse",
          "background-color": "#3fb9ff",
          "background-opacity": 1,
          "border-width": 2,
          "border-color": "#2b6fb8",
          "border-opacity": 1
        }
      },
      // 悬停 / 聚焦：圆圈上方浮现节点短名（带编号），球内仍按标注模式显示
      {
        selector: "node.hovered, node.focused",
        style: {
          "label": function (ele) {
            const id = ele.id();
            const num = getNum(id);
            const name = (allNodes[id] && allNodes[id].label) || "";
            return num ? (num + " " + name) : name;
          },
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": 12,
          "text-background-color": "rgba(255,255,255,0.95)",
          "text-background-opacity": 0.95,
          "text-background-padding": "3px",
          "text-background-shape": "round-rectangle",
          "text-outline-width": 0,
          "text-wrap": "none"
        }
      },
      // 标注模式 = 编号+短名：文字以白底标签形式显示在球下方（不被球裁切）
      {
        selector: "node.lbl-full",
        style: {
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 10,
          "text-wrap": "none",
          "text-max-width": "260px",
          "text-background-color": "rgba(255,255,255,0.95)",
          "text-background-opacity": 0.95,
          "text-background-padding": "2px",
          "text-background-shape": "round-rectangle",
          "text-outline-width": 0
        }
      },
      // 类型配色（实心圆）
      { selector: "node[kind='definition']", style: { "background-color": "#f2c94c", "border-color": "#c9a227" } },
      { selector: "node[kind='example']", style: { "background-color": "#c77dff", "border-color": "#9a5ec9" } },
      { selector: "node[kind='proposition']", style: { "background-color": "#3fb9ff", "border-color": "#2b6fb8" } },
      // 手动导入的定理：暖橙色，区别于教材节点
      { selector: "node[kind='theorem']", style: { "background-color": "#ffb84d", "border-color": "#d98a1f" } },
      { selector: "node[kind='gate']", style: { "shape": "diamond", "width": 28, "height": 28, "background-color": "#ff4d5e", "border-color": "#c22d3a", "label": "∧", "font-size": 14, "color": "#ffffff", "text-valign": "center", "text-halign": "center", "background-opacity": 1, "border-width": 1 } },
      { selector: "node:selected", style: { "border-width": 4, "border-color": "#e01b24" } },
      { selector: "node.faded", style: { "opacity": 0.12 } },
      { selector: "node.focused", style: { "border-width": 4, "border-color": "#e01b24" } },
      // 搜索命中加亮圈：与 faded 叠加时依然醒目
      { selector: "node.hit", style: { "border-width": 4, "border-color": "#ff8c00", "opacity": 1 } },
      // 有笔记的节点：右上角橙色小圆点
      { selector: "node.noted", style: {
        "background-image-containment": "over",
        "background-width": "16px",
        "background-height": "16px",
        "background-position-x": "50%",
        "background-position-y": "-55%",
        "background-clip": "none"
      } },
      // 连接模式：所有球轻微高亮，提示可点击
      { selector: "node.connect-ready", style: {
        "border-color": "#e6c64f",
        "border-width": 3
      } },
      { selector: "edge", style: { "opacity": 0.95 } },
      { selector: "edge.faded", style: { "opacity": 0.06 } },
      { selector: "edge.focused", style: { "opacity": 1, "width": 4 } },
      {
        selector: "edge",
        style: {
          "width": 1.6,
          "curve-style": "bezier",
          "line-color": "#4f9dff",
          "target-arrow-shape": "triangle",
          "target-arrow-color": "#4f9dff",
          "source-arrow-shape": "none",
          "arrow-scale": 1.2,
          "label": "data(label)",
          "font-size": 9,
          "color": "#666666",
          "text-rotation": "autorotate",
          "text-background-color": "rgba(255,255,255,0.9)",
          "text-background-opacity": 0.9,
          "text-background-padding": "2px"
        }
      },
      { selector: "edge[type='equiv']", style: { "line-color": "#4f9dff", "target-arrow-shape": "triangle-tee", "target-arrow-color": "#4f9dff", "source-arrow-shape": "triangle-tee", "source-arrow-color": "#4f9dff" } },
      { selector: "edge[type='impl']", style: { "line-color": "#3ce07a", "target-arrow-shape": "triangle", "target-arrow-color": "#3ce07a" } },
      { selector: "edge[type='joint']", style: { "line-color": "#ff4d5e", "line-style": "dashed", "target-arrow-shape": "triangle", "target-arrow-color": "#ff4d5e" } },
      { selector: "edge[type='aux']", style: { "line-color": "#8f96ad", "line-style": "dotted", "width": 1.2, "target-arrow-shape": "triangle", "target-arrow-color": "#8f96ad" } },
      // 自定义连接（用户手动建立）：灰色虚线、无方向、无标签
      { selector: "edge[type='custom']", style: { "line-color": "#9aa0ad", "line-style": "dashed", "width": 1.6, "target-arrow-shape": "none", "source-arrow-shape": "none" } },
      // 管理面板悬停 / 右键选中的自定义边：深灰色高亮
      { selector: "edge[type='custom'].custom-hl", style: { "line-color": "#4a4f58", "width": 3.2 } },
      { selector: "edge:selected", style: { "width": 4 } }
    ],
    wheelSensitivity: 0.2
  });

  // ================= 流动光点（沿边移动，rAF + 路径缓存） =================
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  const flowDots = new Map();   // edgeId -> {el, t, pts, invalid}
  let flowRaf = null;
  let flowBumped = false;       // 缩放/拖动后需要重取一次路径

  function edgePathPoints(edge) {
    try {
      const segs = edge.renderedBendpoints();
      const ret = [];
      for (let i = 0; i < segs.length; i += 2) {
        ret.push({ x: segs[i], y: segs[i + 1] });
      }
      return ret;
    } catch (e) { return []; }
  }
  function flowTick() {
    flowRaf = null;
    let anyMoving = false;
    cy.edges().forEach(function (edge) {
      const key = edge.id();
      const d = flowDots.get(key);
      if (!edge.visible() || edge.hasClass("faded")) {
        // 边被隐藏/淡出时同步藏起它的光点
        if (d) d.el.style.display = "none";
        return;
      }
      if (!d) {
        const wrap = cy.container() ? cy.container().querySelector(".cy-canvas-layer") : null;
        if (!wrap) return;
        const dot = svgEl("circle", { r: "2.6", fill: "#ffffff", opacity: "0.9", class: "flow-dot" });
        wrap.appendChild(dot);
        flowDots.set(key, { el: dot, t: Math.random(), pts: null, invalid: true });
      }
      const dd = flowDots.get(key);
      if (flowBumped || dd.invalid || !dd.pts) {
        // 曲线路径只在视口变化 / 首次时重算，平时缓存复用
        dd.pts = edgePathPoints(edge);
        dd.invalid = false;
      }
      const pts = dd.pts;
      if (!pts || pts.length < 2) { dd.el.style.display = "none"; return; }
      dd.el.style.display = "";
      dd.t = (dd.t + 0.006) % 1;
      // 线形插值（每段按段数等分，近似弧长）
      const total = pts.length - 1;
      const pos = dd.t * total;
      const i = Math.min(Math.floor(pos), total - 1);
      const f = pos - i;
      const p0 = pts[i], p1 = pts[i + 1];
      dd.el.setAttribute("cx", p0.x + (p1.x - p0.x) * f);
      dd.el.setAttribute("cy", p0.y + (p1.y - p0.y) * f);
      anyMoving = true;
    });
    flowBumped = false;
    // 只在有可见边时才继续排队，图空转时零消耗
    if (anyMoving) flowRaf = requestAnimationFrame(flowTick);
  }
  function startFlowAnimation() {
    if (flowRaf) cancelAnimationFrame(flowRaf);
    flowRaf = requestAnimationFrame(flowTick);
  }
  function stopFlowAnimation() {
    if (flowRaf) { cancelAnimationFrame(flowRaf); flowRaf = null; }
    flowDots.forEach(function (d) { if (d.el && d.el.parentNode) d.el.parentNode.removeChild(d.el); });
    flowDots.clear();
    flowBumped = false;
  }
  // 视口变化时让缓存失效（下一次 tick 重取一次，之后继续缓存）
  cy.on("zoom pan resize", function () {
    if (flowDots.size) flowBumped = true;
  });

  // 初始缩放范围
  cy.minZoom(0.05);
  cy.maxZoom(6);
  const layoutOpts = {
    name: "dagre",
    rankDir: "LR",
    nodeSep: 30,
    rankSep: 110,
    edgeSep: 12,
    animate: false
  };
  // 星云图：fcose 力导向布局 —— 节点像云团一样自然聚散。
  // 参数已针对性能调整：默认质量 + 少量迭代已足够分散，
  // 不再需要 O(n²) 的碰撞后处理（见 runLayout）。
  const cloudLayoutOpts = {
    name: "fcose",
    quality: "default",       // draft 更快但可能局部拥挤；default 已收敛
    randomize: true,          // 随机初始位置，避免初始成一条直线
    animate: false,
    nodeSeparation: 110,      // fcose 的「安全距离」目标，足以避免节点叠压
    idealEdgeLength: 180,
    nodeRepulsion: 200000,
    gravity: 0.08,
    numIter: 600,             // default 质量下 600 次已充分收敛（2600 次收益极小）
    tile: true,
    tilingPaddingVertical: 40,
    tilingPaddingHorizontal: 40,
    fit: true,
    padding: 60
  };
  let currentLayout = "cloud";   // cloud（星云）| logical（逻辑图）

  // ---------- 显隐过滤（不再重建元素） ----------
  function nodeVisibleByFilter(n) {
    if (!state.showDef && n.kind === "definition") return false;
    if (!state.showEx && n.kind === "example") return false;
    if (!state.showUser && n.kind === "theorem") return false;
    return true;
  }
  function edgeVisibleByFilter(e) {
    if (e.type === "equiv" && !state.showEquiv) return false;
    if (e.type === "impl" && !state.showImpl) return false;
    if (e.type === "joint" && !state.showJoint) return false;
    if (e.type === "aux" && !state.showAux) return false;
    return true;
  }
  // 计算「当前应显示的」全部元素（与 buildElements 同规则，但不依赖 cytoscape 状态）
  function computeVisibleSet() {
    const inView = state.view === "all";
    const subjIds = inView ? Object.keys(subjects) : [state.view];
    const nodeIds = [];
    subjIds.forEach(function (sid) { nodeIds.push.apply(nodeIds, nodeIdsBySubject[sid] || []); });
    // 手动导入的节点（kind=theorem）：
    //   - 归属自建学科时，只在该学科视图 / 合并大网显示；
    //   - 通用分组（subjectId='user'）在任何学科视图都显示。
    if (state.showUser) {
      userNodes.order.forEach(function (id) {
        const nn = userNodes.data[id];
        const sid = (nn.subjectId && subjects[nn.subjectId]) ? nn.subjectId : "user";
        if (sid === "user" || inView || state.view === sid) nodeIds.push(id);
      });
    }
    const nodeSet = {};
    nodeIds.forEach(function (id) {
      const n = allNodes[id];
      if (!n) return;
      if (!nodeVisibleByFilter(n)) return;
      nodeSet[id] = true;
    });
    const plainEdges = [];
    allEdges.forEach(function (e) {
      if (subjIds.indexOf(e.subjectId) < 0) return;
      if (!nodeSet[e.source] || !nodeSet[e.target]) return;
      if (!edgeVisibleByFilter(e)) return;
      plainEdges.push({ id: e.id, source: e.source, target: e.target, type: e.type, label: e.label || "", subject: e.subjectId });
    });
    const joints = [];
    allJoints.forEach(function (j) {
      if (subjIds.indexOf(j.subjectId) < 0) return;
      if (!state.showJoint) return;
      if (!nodeSet[j.target]) return;
      const srcIds = j.sources.filter(function (s) { return nodeSet[s]; });
      if (srcIds.length === 0) return;
      joints.push({ id: j.id, srcIds: srcIds, target: j.target });
    });
    // 自定义边（用户手动连接）：两端都在当前视图且开关打开时显示
    const customEdgeList = [];
    if (state.showCustom) {
      Object.keys(customEdges.data).forEach(function (cid) {
        const e = customEdges.data[cid];
        if (!e || e.source === e.target) return;
        if (!nodeSet[e.source] || !nodeSet[e.target]) return;
        customEdgeList.push({ id: e.id, source: e.source, target: e.target, type: "custom" });
      });
    }
    // 计算全部应显示的边 id（普通边 + 联合门的进出边 + 自定义边），供显隐过滤快速查询
    const edgeIds = {};
    plainEdges.forEach(function (e) { edgeIds[e.id] = true; });
    joints.forEach(function (j) {
      edgeIds[j.id + ":out"] = true;
      j.srcIds.forEach(function (s) { edgeIds[j.id + ":in:" + s] = true; });
    });
    customEdgeList.forEach(function (e) { edgeIds[e.id] = true; });
    const gateIds = {};
    joints.forEach(function (j) { gateIds[j.id + ":gate"] = true; });
    return { nodeSet: nodeSet, edges: plainEdges, joints: joints, customEdges: customEdgeList, edgeIds: edgeIds, gateIds: gateIds };
  }

  // ---------- 笔记徽标（详情页保存的笔记在图上显示橙色角标） ----------
  const notedIds = new Set();
  function refreshNotedBadges() {
    if (!window.KGNotes) return;
    window.KGNotes.list().then(function (items) {
      notedIds.clear();
      items.forEach(function (m) { if (m && m.id) notedIds.add(m.id); });
      cy.nodes().forEach(function (node) {
        const on = notedIds.has(node.id());
        node.toggleClass("noted", on);
        node.css("background-image", on ? NOTED_DOT_SVG : "none");
      });
    }).catch(function () { /* 存储不可用时静默 */ });
  }

  // ---------- 元素构建（仅启动 / 切换学科视图时使用） ----------
  function buildElements() {
    const els = [];
    const v = computeVisibleSet();
    Object.keys(v.nodeSet).forEach(function (id) {
      const n = allNodes[id];
      const num = getNum(id);
      const name = n.label || "";
      let lbl = "";
      if (state.labelMode === "num") lbl = num;
      else if (state.labelMode === "full") lbl = num ? (num + " " + name) : name;
      els.push({
        group: "nodes",
        data: { id: id, label: n.label, lbl: lbl, kind: n.kind, title: n.title || n.label, subject: n.subjectId, w: 44 * (state.nodeScale[id] || 1) },
        classes: (notedIds.has(id) ? "noted " : "") + (state.labelMode === "full" ? "lbl-full" : "")
      });
    });
    v.edges.forEach(function (e) {
      els.push({ group: "edges", data: { id: e.id, source: e.source, target: e.target, type: e.type, label: e.label || "", subject: e.subject } });
    });
    v.joints.forEach(function (j) {
      const gateId = j.id + ":gate";
      els.push({ group: "nodes", data: { id: gateId, label: "∧", kind: "gate", subject: "" } });
      j.srcIds.forEach(function (src) {
        els.push({ group: "edges", data: { id: j.id + ":in:" + src, source: src, target: gateId, type: "joint", subject: "" } });
      });
      els.push({ group: "edges", data: { id: j.id + ":out", source: gateId, target: j.target, type: "joint", subject: "" } });
    });
    // 自定义边（灰色虚线）
    (v.customEdges || []).forEach(function (e) {
      els.push({ group: "edges", data: { id: e.id, source: e.source, target: e.target, type: "custom", label: "", subject: "" } });
    });
    return els;
  }

  // ---------- 布局 ----------
  // 最小间距后处理（模型坐标 + 空间哈希，只在布局完成时跑一次）
  // 关键：必须在「模型坐标」里做 —— 任意两球圆心距 >= 半径A+半径B+8，
  // 与缩放级别无关。（之前误用屏幕像素坐标，被随后的 cy.fit() 重新缩放抵消。）
  // 分桶只比较邻近圆，300 个节点约 20ms 内完成，不影响交互流畅度。
  // 支持被「放大此球」改过的大小：按每个球的实际半径计算所需间距。
  function enforceMinGap(baseGap) {
    const nodes = cy.nodes().filter(function (n) {
      return n.visible() && n.data("kind") !== "gate";
    });
    const n = nodes.length;
    if (n < 2) return;
    const pos = [];
    for (let i = 0; i < n; i++) {
      const p = nodes[i].position();
      const w = parseFloat(nodes[i].data("w")) || 44;
      pos.push({ x: p.x, y: p.y, r: w / 2 + 4, deg: nodes[i].degree(false) });
    }
    // 分桶格宽取最大半径的两倍，保证任何可能冲突的对都在同格或邻格
    let maxR = 26;
    for (let i = 0; i < n; i++) if (pos[i].r > maxR) maxR = pos[i].r;
    const cell = Math.max(2 * maxR, baseGap);
    const dxs = new Float64Array(n), dys = new Float64Array(n);
    const DEG = 3;               // 幂次：度越高的节点越"锚定"，低度节点让位

    // 每轮重建分桶：节点会被推开，位置变了必须重新哈希，否则漏检
    function buildBuckets() {
      const buckets = new Map();
      for (let i = 0; i < n; i++) {
        const cx = Math.floor(pos[i].x / cell), cy = Math.floor(pos[i].y / cell);
        const k = cx + ":" + cy;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(i);
      }
      return buckets;
    }

    for (let pass = 0; pass < 8; pass++) {
      const buckets = buildBuckets();
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const pi = pos[i];
        const cx = Math.floor(pi.x / cell), cy = Math.floor(pi.y / cell);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const bucket = buckets.get((cx + ox) + ":" + (cy + oy));
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const j = bucket[b];
              if (j <= i) continue;
              const pj = pos[j];
              const dx = pj.x - pi.x, dy = pj.y - pi.y;
              const d2 = dx * dx + dy * dy;
              const need = pi.r + pj.r;      // 按实际球半径计算
              if (d2 >= need * need) continue;
              let d = Math.sqrt(d2);
              let ux, uy;
              if (d < 0.0001) {
                // 圆心恰好重合：沿固定方向错开，避免零向量推不动
                ux = Math.cos(i * 2.39996);
                uy = Math.sin(i * 2.39996);
                d = 0.0001;
              } else {
                ux = dx / d; uy = dy / d;
              }
              const overlap = need - d;
              // 度数低者让位多：权重 = 1/(deg+1)^DEG
              const wa = 1 / Math.pow(pi.deg + 1, DEG);
              const wb = 1 / Math.pow(pj.deg + 1, DEG);
              const s = wa + wb;
              const shA = overlap * wa / s, shB = overlap * wb / s;
              dxs[i] -= ux * shA; dys[i] -= uy * shA;
              dxs[j] += ux * shB; dys[j] += uy * shB;
              moved++;
            }
          }
        }
      }
      if (moved === 0) break;
      for (let i = 0; i < n; i++) {
        if (dxs[i] !== 0 || dys[i] !== 0) {
          pos[i].x += dxs[i]; pos[i].y += dys[i];
          dxs[i] = 0; dys[i] = 0;
        }
      }
    }
    // 一次性批量写回模型坐标，触发单次重绘（模型坐标不受 zoom/fit 影响）
    cy.batch(function () {
      for (let i = 0; i < n; i++) {
        nodes[i].position({ x: pos[i].x, y: pos[i].y });
      }
    });
  }

  function runLayout(kind) {
    // 已有保存的相对位置则原样恢复（含间距倍率与单球大小），不再重排 ——
    // 只有右键空白处「重新布局」才会走到真正重排。
    if (applyStoredLayout()) {
      // 首次打开时容器可能尚未完成布局，等一帧再取景
      requestAnimationFrame(function () {
        cy.fit(undefined, 60);
      });
      startFlowAnimation();
      return;
    }
    const opts = kind === "cloud" ? cloudLayoutOpts : layoutOpts;
    // fcose 若因插件未加载而失败，退回内置随机布局，保证页面一定能出图
    let layout;
    try {
      layout = cy.layout(opts);
    } catch (e) {
      console.warn("布局失败，使用随机布局兜底:", e);
      layout = cy.layout({ name: "random", fit: true, padding: 60, animate: false });
    }
    layout.one("layoutstop", function () {
      if (kind === "cloud") {
        enforceMinGap(52);      // 最小圆心间距 52 模型单位（球径 44，留 8 单位缝）
        cy.fit(undefined, 60);  // 分离后再取景（模型坐标不随缩放变化，不会被抵消）
      } else {
        enforceMinGap(48);      // 逻辑图也做兜底：dagre 偶发局部挤叠时拉开
      }
      saveLayoutMemory();
      startFlowAnimation();
    });
    layout.run();
  }

  // ---------- 搜索（倒排索引 + 命中加亮） ----------
  const searchHits = new Set();
  let searchTimer = null;
  function applySearch() {
    const q = state.query;
    searchHits.clear();
    if (q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      Object.keys(allNodes).forEach(function (id) {
        const n = allNodes[id];
        if (!n) return;
        const hay = (n.label + " " + (n.title || "") + " " + plainText(n.statement || "")).toLowerCase();
        if (terms.every(function (t) { return hay.indexOf(t) >= 0; })) searchHits.add(id);
      });
    }
    const els = cy.elements();
    const any = searchHits.size > 0;
    cy.batch(function () {
      els.forEach(function (el) {
        if (el.isNode()) {
          el.toggleClass("hit", any && searchHits.has(el.id()));
          if (any) el.toggleClass("faded", !searchHits.has(el.id()));
          else el.removeClass("faded");
        } else if (any) {
          el.addClass("faded");
        } else {
          el.removeClass("faded");
        }
      });
    });
    // 命中集合取景
    if (any) {
      const eles = cy.collection();
      searchHits.forEach(function (id) {
        const el = cy.getElementById(id);
        if (!el.empty()) eles.merge(el);
      });
      if (eles.length) cy.animate({ fit: { eles: eles, padding: 120 } }, { duration: 300 });
    }
  }

  // ---------- 视图应用 ----------
  function applyView() {
    stopFlowAnimation();
    cy.elements().remove();
    cy.add(buildElements());
    runLayout(currentLayout);   // 内部优先恢复已存位置，无存档才真正跑布局
    syncUserNodes();            // 手动导入的节点（kind=theorem）补进图
    if (state.query) applySearch();
    refreshNotedBadges();   // 重建后重新套用笔记角标
    $("view-label").textContent = state.view === "all"
      ? "视图：全部学科（合并大网）"
      : "视图：" + (subjects[state.view] ? subjects[state.view].label : state.view);
  }
  // 仅切换显隐过滤（不重建、不重排）
  function applyFilters() {
    const v = computeVisibleSet();
    cy.batch(function () {
      cy.nodes().forEach(function (node) {
        const on = v.nodeSet[node.id()] === true || v.gateIds[node.id()] === true;
        node.style("display", on ? "element" : "none");
      });
      cy.edges().forEach(function (edge) {
        const on = v.edgeIds[edge.id()] === true;
        edge.style("display", on ? "element" : "none");
      });
    });
    if (state.query) applySearch();
  }

  // ---------- 侧栏详情 ----------
  function edgeTypeName(t) {
    return { equiv: "等价", impl: "推论", joint: "联合", aux: "证明依赖", custom: "自定义连接" }[t] || t;
  }
  function collectRelations(id) {
    const rels = [];
    allEdges.forEach(function (e) {
      if (e.source === id) rels.push({ other: e.target, type: e.type, typeName: edgeTypeName(e.type), label: e.label, dir: "out" });
      if (e.target === id) rels.push({ other: e.source, type: e.type, typeName: edgeTypeName(e.type), label: e.label, dir: "in" });
    });
    allJoints.forEach(function (j) {
      if (j.sources.indexOf(id) >= 0) rels.push({ other: j.target, type: "joint", typeName: "联合推出", label: j.label, dir: "out" });
      if (j.target === id) j.sources.forEach(function (s) { rels.push({ other: s, type: "joint", typeName: "联合推出", label: j.label, dir: "in" }); });
    });
    // 自定义连接（灰色虚线）
    Object.keys(customEdges.data).forEach(function (cid) {
      const e = customEdges.data[cid];
      if (e.source === id) rels.push({ other: e.target, type: "custom", typeName: "自定义连接", label: "", dir: "out" });
      if (e.target === id) rels.push({ other: e.source, type: "custom", typeName: "自定义连接", label: "", dir: "in" });
    });
    return rels;
  }

  // KaTeX 渲染结果缓存：key = id + 字段名，value = DOM 节点（clone 复用）
  const mathCache = new Map();
  function mathKey(id, field) { return id + "::" + field; }
  function renderMathInto(box, id, field, text) {
    if (!text) { box.innerHTML = ""; return; }
    const key = mathKey(id, field);
    const hit = mathCache.get(key);
    if (hit && hit.nodeType === 1) {
      box.innerHTML = "";
      box.appendChild(hit.cloneNode(true));
      return;
    }
    box.textContent = text;
    if (window.renderMathInElement) {
      try {
        renderMathInElement(box, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false }
          ],
          throwOnError: false
        });
      } catch (e) { /* 保留原文本 */ }
    }
    mathCache.set(key, box.firstChild ? box.firstChild.cloneNode(true) : document.createTextNode(text));
  }

  function renderPanel(id) {
    const panel = $("panel");
    const n = allNodes[id];
    if (!n) { panel.innerHTML = '<div class="empty">未找到节点 ' + escapeHtml(id) + "</div>"; panel.classList.add("open"); return; }
    const kindName = { definition: "定义", example: "特例", proposition: "命题 / 引理", theorem: "手动导入定理", gate: "联合门" }[n.kind] || n.kind;
    const subj = subjects[n.subjectId] || (n.subjectId === "user" ? { label: "我的节点", color: "#d98a1f" } : {});
    const parts = [];
    const nodeNum = getNum(id);
    parts.push("<h2>" + (nodeNum ? "<span style='color:var(--muted);font-weight:700;margin-right:6px;'>" + escapeHtml(nodeNum) + "</span>" : "") + escapeHtml(n.title || n.label) + "</h2>");
    parts.push('<div class="meta">类型：' + kindName +
      (subj.label ? " · 学科：<span style='color:" + escapeHtml(subj.color) + "'>" + escapeHtml(subj.label) + "</span>" : "") +
      (n.ref ? " · " + escapeHtml(n.ref) : "") +
      (n.page ? " · 印刷 p." + n.page + "（PDF 第 " + (n.pdfPage || "") + " 页）" : "") +
      "</div>");
    if (n.statement) {
      parts.push('<div class="sec-title">陈述</div><div class="statement" id="stmt-box"></div>');
    }
    if (n.proof) {
      parts.push('<div class="sec-title">证明</div><div class="statement" id="proof-box"></div>');
    }
    const rels = collectRelations(id);
    if (rels.length) {
      parts.push('<div class="sec-title">与其他命题 / 定义的关系</div><ul class="link-list">');
      rels.forEach(function (r) {
        const other = allNodes[r.other];
        const name = other ? (other.title || other.label) : r.other;
        parts.push(
          "<li><span class='edge-chip " + r.type + "'>" + r.typeName + "</span>" +
          "<a href='#' data-node-id='" + escapeHtml(r.other) + "'>" + escapeHtml(name) + "</a>" +
          (r.label ? " <span style='color:var(--muted)'>（" + escapeHtml(r.label) + "）</span>" : "") +
          "</li>"
        );
      });
      parts.push("</ul>");
    }
    const gate = allJoints.filter(function (j) { return j.target === id || j.sources.indexOf(id) >= 0; });
    if (gate.length) {
      parts.push('<div class="sec-title">参与的联合蕴含</div><ul class="link-list">');
      gate.forEach(function (j) {
        const srcNames = j.sources.map(function (s) {
          const sn = allNodes[s]; return sn ? (sn.title || sn.label) : s;
        }).join("、");
        const tn = allNodes[j.target]; const tName = tn ? (tn.title || tn.label) : j.target;
        parts.push("<li><span class='edge-chip joint'>联合</span>" + escapeHtml(srcNames) + " ⟹ " + escapeHtml(tName) +
          (j.ref ? " <span style='color:var(--muted)'>（" + escapeHtml(j.ref) + "）</span>" : "") + "</li>");
      });
      parts.push("</ul>");
    }
    parts.push(
      '<div class="actions">' +
      '<button class="primary" id="btn-open-page">在新窗口打开完整详情</button>' +
      (n.pdfUrl ? '<a class="btn" style="text-decoration:none;display:inline-flex;align-items:center;" target="_blank" rel="noopener" href="' + escapeHtml(n.pdfUrl) + '">📄 打开原书 PDF</a>' : "") +
      '<button id="btn-focus">在图内聚焦</button>' +
      "</div>"
    );
    panel.innerHTML = parts.join("");
    panel.classList.add("open");

    // 陈述与证明：LaTeX 渲染（带缓存），避免 < 被转义破坏 KaTeX
    const stmtBox = $("stmt-box");
    if (stmtBox) renderMathInto(stmtBox, id, "statement", n.statement);
    const proofBox = $("proof-box");
    if (proofBox) renderMathInto(proofBox, id, "proof", n.proof);

    // 事件
    panel.querySelectorAll("a[data-node-id]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        focusNode(a.getAttribute("data-node-id"));
        renderPanel(a.getAttribute("data-node-id"));
      });
    });
    const btnOpen = $("btn-open-page");
    if (btnOpen) btnOpen.addEventListener("click", function () { openNodePage(id); });
    const btnFocus = $("btn-focus");
    if (btnFocus) btnFocus.addEventListener("click", function () { focusNode(id); });
  }

  // ---------- 交互 ----------
  let focusedId = null;   // 聚焦模式：当前主角
  function applyFocusClasses() {
    cy.batch(function () {
      cy.nodes().forEach(function (n) {
        n.removeClass("faded focused");
        n.css("border-width", 2);
      });
      cy.edges().forEach(function (e) { e.removeClass("faded focused"); e.css("width", 1.6); });
      if (focusedId) {
        const center = cy.getElementById(focusedId);
        const neighbors = center.closedNeighborhood().nodes();
        cy.nodes().forEach(function (n) {
          if (!neighbors.contains(n)) n.addClass("faded");
        });
        center.addClass("focused");
        cy.edges().forEach(function (e) {
          const touch = e.source().id() === focusedId || e.target().id() === focusedId;
          if (touch) { e.addClass("focused"); e.css("width", 3.2); } else { e.addClass("faded"); }
        });
        $("btn-focus-off").style.display = "";
      } else {
        $("btn-focus-off").style.display = "none";
      }
    });
  }
  function focusNode(id) {
    const el = cy.getElementById(id);
    if (el.empty()) return;
    cy.animate({ fit: { eles: el, padding: 120 } }, { duration: 400 });
    el.select();
  }
  function focusHero(id) {
    focusedId = id;
    focusNode(id);
    applyFocusClasses();
  }
  function clearFocus() {
    focusedId = null;
    applyFocusClasses();
  }
  function openNodePage(id) {
    // 绝对 URL + 多层回退，避免浏览器拦截 window.open 导致"加载失败"白页
    const url = new URL("node.html?id=" + encodeURIComponent(id), window.location.href).href;
    let win = null;
    try {
      win = window.open(url, "_blank", "width=900,height=700");
    } catch (e) { win = null; }
    if (!win) {
      try { win = window.open(url, "_blank"); } catch (e2) { win = null; }
    }
    if (!win) {
      // 最后兜底：本窗口内跳转（可后退）
      window.location.href = url;
    }
  }

  // ================= 右键菜单（节点：单球缩放/撤销；空白：重新布局/撤销） =================
  let ctxMenu = null;
  function closeCtxMenu() {
    if (ctxMenu) {
      ctxMenu.parentNode && ctxMenu.parentNode.removeChild(ctxMenu);
      ctxMenu = null;
    }
  }
  document.addEventListener("click", closeCtxMenu);
  function showCtxMenu(x, y, items) {
    closeCtxMenu();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    items.forEach(function (it) {
      if (!it) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctx-item";
      btn.textContent = it.label;
      if (it.danger) btn.classList.add("danger");
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        closeCtxMenu();
        it.action && it.action();
      });
      menu.appendChild(btn);
    });
    // 定位并防止溢出窗口（position: fixed，坐标即视口坐标）
    menu.style.position = "fixed";
    menu.style.left = "0px";
    menu.style.top = "0px";
    document.body.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const px = Math.min(x, window.innerWidth - mw - 8);
    const py = Math.min(y, window.innerHeight - mh - 8);
    menu.style.left = px + "px";
    menu.style.top = py + "px";
    ctxMenu = menu;
  }

  // 单球放大 / 缩小（并推开相邻球，避免新尺寸造成叠压）
  function scaleOneNode(id, factor) {
    const el = cy.getElementById(id);
    if (el.empty() || el.data("kind") === "gate") return;
    const cur = state.nodeScale[id] || 1;
    const next = Math.min(2.5, Math.max(0.6, cur * factor));
    if (Math.abs(next - cur) < 0.01) return;
    pushUndo("node-scale");
    state.nodeScale[id] = next;
    const w = 44 * next;
    el.data("w", w);
    // 把邻居推开一点：避免放大后压到别的球
    const px = el.position();
    el.connectedEdges().connectedNodes().filter(function (nd) {
      return nd.id() !== id && nd.data("kind") !== "gate" && nd.visible();
    }).forEach(function (nb) {
      const np = nb.position();
      const dx = np.x - px.x, dy = np.y - px.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.0001) return;
      const need = 26 + 22 * next + 22 * (state.nodeScale[nb.id()] || 1);
      if (d < need) {
        const push = (need - d) * 0.8;
        nb.position({ x: np.x + (dx / d) * push, y: np.y + (dy / d) * push });
      }
    });
    scheduleLayoutSave();
  }
  function resetNodeSize(id) {
    if (!(state.nodeScale[id] > 0)) return;
    pushUndo("node-reset");
    delete state.nodeScale[id];
    const el = cy.getElementById(id);
    if (!el.empty()) el.data("w", 44);
    scheduleLayoutSave();
  }

  // ================= 自定义边（用户手动建立灰色虚线连接） =================
  function addCustomEdge(source, target) {
    if (!source || !target || source === target) return false;
    // 已存在同向或反向的连接则不重复建立
    const exists = Object.keys(customEdges.data).some(function (cid) {
      const e = customEdges.data[cid];
      return (e.source === source && e.target === target) || (e.source === target && e.target === source);
    });
    if (exists) return false;
    const id = "custom:" + source + "|" + target + ":" + Date.now();
    customEdges.data[id] = { id: id, source: source, target: target, ts: Date.now() };
    customEdges.save();          // 立即持久化（无需手动保存）
    syncCustomEdges();
    return true;
  }
  function removeCustomEdge(edgeId) {
    if (!customEdges.data[edgeId]) return false;
    delete customEdges.data[edgeId];
    customEdges.save();          // 立即持久化
    syncCustomEdges();
    return true;
  }
  // 把自定义边同步进图（保留其他元素，只增删 custom 边）。
  // 注意：这里的「存在与否」与显隐开关无关 —— 只要数据里有、且两端节点当前在图中，
  // 就加入图（display 由 applyFilters 统一控制），否则撤销时会被误删。
  function syncCustomEdges() {
    const graphNodeIds = {};
    cy.nodes().forEach(function (nd) { graphNodeIds[nd.id()] = true; });
    const want = {};
    Object.keys(customEdges.data).forEach(function (cid) {
      const e = customEdges.data[cid];
      if (e && e.source !== e.target && graphNodeIds[e.source] && graphNodeIds[e.target]) want[e.id] = e;
    });
    // 删除图上已不在数据中的自定义边
    cy.edges().forEach(function (edge) {
      if (edge.data("type") === "custom" && !want[edge.id()]) edge.remove();
    });
    // 添加数据中存在但图上没有的
    cy.batch(function () {
      Object.keys(want).forEach(function (eid) {
        if (cy.getElementById(eid).empty()) {
          const e = want[eid];
          cy.add({ group: "edges", data: { id: e.id, source: e.source, target: e.target, type: "custom", label: "" } });
        }
      });
    });
  }

  // ================= 手动导入节点（单个/批量） =================
  function isUserNodeId(id) { return userNodes.data[id] !== undefined; }
  function addUserNode(node) {
    if (!node || !node.id) return false;
    if (allNodes[node.id] && !isUserNodeId(node.id)) {
      return false;      // 与教材节点 id 冲突
    }
    const isNew = !userNodes.data[node.id];
    const sid = (node.subjectId && subjects[node.subjectId]) ? node.subjectId : "user";
    const record = {
      id: node.id,
      kind: "theorem",
      subjectId: sid,
      label: String(node.label || ""),
      title: String(node.title || node.label || ""),
      statement: String(node.statement || ""),
      proof: String(node.proof || ""),
      ref: String(node.ref || ""),
      note: String(node.note || ""),
      manualNum: typeof node.manualNum === "number" ? node.manualNum : undefined
    };
    if (isNew) {
      userNodes.data[node.id] = record;
      userNodes.order.push(node.id);
      // 分配编号（教材节点之后追加）
      record.manualNum = nextUserNum++;
      initialNum[node.id] = record.manualNum;
      if (nodeIdsBySubject[sid]) nodeIdsBySubject[sid].push(node.id);
    } else {
      userNodes.data[node.id] = Object.assign({}, userNodes.data[node.id], record);
    }
    userNodes.save();
    // 同步到 allNodes 与图
    allNodes[node.id] = Object.assign({}, userNodes.data[node.id], { subjectId: sid });
    const el = cy.getElementById(node.id);
    if (el.empty()) {
      const num = getNum(node.id);
      const name = String(node.label || "");
      let lbl = "";
      if (state.labelMode === "num") lbl = num;
      else if (state.labelMode === "full") lbl = num ? (num + " " + name) : name;
      cy.add({
        group: "nodes",
        data: { id: node.id, label: name, lbl: lbl, kind: "theorem", title: record.title, subject: sid, w: 44 * (state.nodeScale[node.id] || 1) },
        classes: (state.labelMode === "full" ? "lbl-full" : "")
      });
    } else {
      el.data({ label: record.label, kind: "theorem", title: record.title, subject: sid });
      applyLabelMode();
    }
    // 让新球出现在视图中央附近（先套用当前显隐过滤，避免隐藏状态下误 fit）
    applyFilters();
    if (el.length && el.visible()) {
      cy.animate({ fit: { eles: el, padding: 140 } }, { duration: 300 });
    }
    refreshCustomManager();
    return true;
  }
  function removeUserNode(id) {
    if (!isUserNodeId(id)) return false;
    // 连带删除与该节点相关的自定义边
    Object.keys(customEdges.data).forEach(function (cid) {
      const e = customEdges.data[cid];
      if (e.source === id || e.target === id) delete customEdges.data[cid];
    });
    customEdges.save();
    syncCustomEdges();
    delete userNodes.data[id];
    userNodes.order = userNodes.order.filter(function (x) { return x !== id; });
    userNodes.save();
    delete allNodes[id];
    const el = cy.getElementById(id);
    if (!el.empty()) el.remove();
    refreshCustomManager();
    return true;
  }
  // ================= 自建学科（用户创建 / 重命名 / 删除） =================
  function addUserSubject(label, color) {
    const baseId = "u_" + String(label || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16).toLowerCase() || "subj";
    let id = baseId, i = 1;
    while (subjects[id]) { id = baseId + "_" + (++i); }
    const s = { id: id, label: String(label).trim() || "新学科", color: color || "#9141ac", user: true };
    userSubjects.data.push(s);
    userSubjects.save();
    subjects[s.id] = s;
    nodeIdsBySubject[s.id] = [];
    return s;
  }
  function removeUserSubject(id) {
    if (!subjects[id] || !subjects[id].user) return false;
    // 学科下的节点迁回通用分组
    userNodes.order.forEach(function (nid) {
      const nn = userNodes.data[nid];
      if (nn.subjectId === id) {
        nn.subjectId = "user";
        allNodes[nid] = Object.assign({}, nn, { subjectId: "user" });
        const el = cy.getElementById(nid);
        if (!el.empty()) el.data("subject", "user");
      }
    });
    userNodes.save();
    delete subjects[id];
    userSubjects.data = userSubjects.data.filter(function (s) { return s.id !== id; });
    userSubjects.save();
    if (state.view === id) {
      state.view = "topology";
      applyView();
    }
    return true;
  }
  function syncUserNodes() {
    // 图内补齐/移除 user 节点（不触及其他元素）
    cy.nodes().forEach(function (nd) {
      if (nd.data("kind") === "theorem" && !userNodes.data[nd.id()]) nd.remove();
    });
    cy.batch(function () {
      userNodes.order.forEach(function (id) {
        if (cy.getElementById(id).empty()) {
          const n = userNodes.data[id];
          const sid = (n.subjectId && subjects[n.subjectId]) ? n.subjectId : "user";
          const num = getNum(id);
          const name = String(n.label || "");
          let lbl = "";
          if (state.labelMode === "num") lbl = num;
          else if (state.labelMode === "full") lbl = num ? (num + " " + name) : name;
          cy.add({
            group: "nodes",
            data: { id: id, label: name, lbl: lbl, kind: "theorem", title: n.title || name, subject: sid, w: 44 * (state.nodeScale[id] || 1) },
            classes: (state.labelMode === "full" ? "lbl-full" : "")
          });
        }
      });
    });
  }

  // ================= 我的连接管理面板 =================
  // 面板列出全部手动建立的连接；悬停条目 → 图上对应边深灰高亮；可单条/全部删除。
  function renderCustomManager() {
    const mgr = $("custom-mgr");
    const list = $("custom-mgr-list");
    const empty = $("custom-mgr-empty");
    const countEl = $("custom-count");
    if (!mgr || !list || !empty) return;
    const entries = Object.keys(customEdges.data).map(function (cid) { return customEdges.data[cid]; });
    if (countEl) countEl.textContent = String(entries.length);
    if (!entries.length) {
      list.innerHTML = "";
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";
    list.innerHTML = "";
    entries.forEach(function (e) {
      const item = document.createElement("div");
      item.className = "custom-mgr-item";
      item.dataset.edgeId = e.id;
      const srcName = allNodes[e.source] ? allNodes[e.source].label : e.source;
      const tgtName = allNodes[e.target] ? allNodes[e.target].label : e.target;
      const line = document.createElement("span");
      line.className = "conn-line";
      const name = document.createElement("span");
      name.className = "conn-name";
      name.textContent = srcName + " ⇄ " + tgtName;
      name.title = srcName + " ⇄ " + tgtName;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "conn-del";
      del.textContent = "删除";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        pushUndo("custom-edge");
        removeCustomEdge(e.id);
        renderCustomManager();
        flashStatus("已删除连接（已自动保存）");
      });
      item.appendChild(line);
      item.appendChild(name);
      item.appendChild(del);
      // 悬停：图上对应边变深灰高亮；离开恢复
      item.addEventListener("mouseenter", function () {
        const el = cy.getElementById(e.id);
        if (!el.empty()) el.addClass("custom-hl");
      });
      item.addEventListener("mouseleave", function () {
        const el = cy.getElementById(e.id);
        if (!el.empty()) el.removeClass("custom-hl");
      });
      // 点击条目：定位到这条边
      item.addEventListener("click", function () {
        const el = cy.getElementById(e.id);
        if (!el.empty()) {
          cy.animate({ fit: { eles: el, padding: 160 } }, { duration: 350 });
        }
      });
      list.appendChild(item);
    });
  }
  function toggleCustomManager(show) {
    const mgr = $("custom-mgr");
    if (!mgr) return;
    const willShow = (show !== undefined) ? show : mgr.classList.contains("hidden");
    mgr.classList.toggle("hidden", !willShow);
    if (willShow) renderCustomManager();
  }
  // 数据变化后刷新面板（若面板开着）
  function refreshCustomManager() {
    const mgr = $("custom-mgr");
    if (mgr && !mgr.classList.contains("hidden")) renderCustomManager();
  }

  // 右键空白：重新布局（只在此处才改变相对位置）
  function relayoutFromScratch() {
    pushUndo("relayout");
    state.scale = 1;
    state.nodeScale = {};
    syncSlider();
    stopFlowAnimation();
    // 删除已存位置，让 runLayout 走全新 fcose 重排
    const key = memKey(state.view, currentLayout);
    delete layoutMemory.data[key];
    layoutMemory.save();
    runLayout(currentLayout);
  }

  // 连接模式：右键「🔗 连接另一个球」后，左键点击目标球完成连接
  let connectSource = null;
  let connectHint = null;
  function startConnect(sourceId) {
    connectSource = sourceId;
    const n = allNodes[sourceId];
    if (!connectHint) {
      connectHint = document.createElement("div");
      connectHint.style.cssText =
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:1000;" +
        "background:#fffbe6;border:1px solid #e6c64f;border-radius:8px;padding:8px 16px;" +
        "font-size:13px;color:#7a6200;box-shadow:0 2px 8px rgba(0,0,0,0.12);";
      document.body.appendChild(connectHint);
    }
    connectHint.textContent = "正在连接：" + (n ? n.label : sourceId) + " → 请左键点击目标球（右键/点空白取消）";
    connectHint.style.display = "";
    cy.nodes().addClass("connect-ready");
  }
  function cancelConnect() {
    connectSource = null;
    if (connectHint) connectHint.style.display = "none";
    cy.nodes().removeClass("connect-ready");
  }
  function finishConnect(targetId) {
    const src = connectSource;
    cancelConnect();
    if (!src || src === targetId) return;
    if (allNodes[targetId] === undefined) return;
    pushUndo("custom-edge");
    const ok = addCustomEdge(src, targetId);
    if (ok) {
      flashStatus("已建立连接（灰色虚线，已自动保存）");
    } else {
      flashStatus("这两个球之间已有连接");
    }
    if (state.selected === src || state.selected === targetId) renderPanel(state.selected);
  }
  // 短暂提示条（复用 connectHint 元素）
  function flashStatus(msg) {
    if (!connectHint) {
      connectHint = document.createElement("div");
      connectHint.style.cssText =
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:1000;" +
        "background:#e8f5e9;border:1px solid #7ab77e;border-radius:8px;padding:8px 16px;" +
        "font-size:13px;color:#1f5c25;box-shadow:0 2px 8px rgba(0,0,0,0.12);";
      document.body.appendChild(connectHint);
    }
    connectHint.textContent = msg;
    connectHint.style.display = "";
    clearTimeout(flashStatus._t);
    flashStatus._t = setTimeout(function () { connectHint.style.display = "none"; }, 2000);
  }

  cy.on("cxttap", "node", function (evt) {
    const node = evt.target;
    if (node.data("kind") === "gate") return;
    const id = node.id();
    const items = [
      { label: "🔍 放大此球", action: function () { scaleOneNode(id, 1.25); } },
      { label: "🔎 缩小此球", action: function () { scaleOneNode(id, 0.8); } },
      (state.nodeScale[id] ? { label: "↩ 恢复默认大小", action: function () { resetNodeSize(id); } } : null),
      { label: "✏ 自定义编号…", action: function () { setCustomNum(id); } },
      { label: "🔗 连接另一个球", action: function () { startConnect(id); } },
      (isUserNodeId(id) ? { label: "🗑 删除此节点（手动导入）", danger: true, action: function () {
        pushUndo("user-node");
        removeUserNode(id);
        flashStatus("已删除手动导入的节点（已自动保存）");
      } } : null),
      { label: "↶ 撤销上次改变", action: undoLast, danger: !undoStack.length }
    ];
    showCtxMenu(evt.originalEvent.clientX, evt.originalEvent.clientY, items);
  });
  cy.on("cxttap", function (evt) {
    if (evt.target !== cy) return;
    showCtxMenu(evt.originalEvent.clientX, evt.originalEvent.clientY, [
      { label: "🔄 重新布局", action: relayoutFromScratch },
      { label: "↶ 撤销上次改变", action: undoLast, danger: !undoStack.length }
    ]);
  });
  // 右键自定义边：删除
  cy.on("cxttap", "edge", function (evt) {
    const edge = evt.target;
    if (edge.data("type") !== "custom") return;
    showCtxMenu(evt.originalEvent.clientX, evt.originalEvent.clientY, [
      { label: "🗑 删除这条连接", danger: true, action: function () {
        pushUndo("custom-edge");
        removeCustomEdge(edge.id());
        flashStatus("已删除连接（已自动保存）");
      } }
    ]);
  });
  // 连接模式下左键点击目标球完成连接；点击空白取消
  cy.on("tap", "node", function (evt) {
    if (connectSource === null) return;      // 非连接模式走普通单击
    evt.stopPropagation && evt.stopPropagation();
    const id = evt.target.id();
    if (id === connectSource) { cancelConnect(); return; }
    finishConnect(id);
  });
  cy.on("tap", function (evt) {
    if (evt.target === cy) {
      if (connectSource !== null) cancelConnect();
      if (focusedId) { clearFocus(); }
    }
  });
  // 屏蔽浏览器原生右键菜单（图上区域）
  $("cy").addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

  // 拖拽节点：拖完记录快照（供撤销）并持久化新位置
  const dragBase = new Map();   // nodeId -> 拖拽前的快照
  cy.on("grab", "node", function (evt) {
    const nd = evt.target;
    if (nd.data("kind") === "gate") return;
    dragBase.set(nd.id(), snapshotNow());
  });
  cy.on("free", "node", function (evt) {
    const nd = evt.target;
    if (nd.data("kind") === "gate") return;
    const base = dragBase.get(nd.id());
    if (base) {
      pushUndo("drag", base);
      dragBase.delete(nd.id());
    }
    scheduleLayoutSave();
  });
  // Ctrl+Z 撤销
  document.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "z" || ev.key === "Z")) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return; // 输入框里交给浏览器
      ev.preventDefault();
      undoLast();
    }
  });
  // 间距滑块
  const scaleSlider = $("layout-scale");
  if (scaleSlider) {
    let scaleDragStart = null;
    scaleSlider.addEventListener("input", function () {
      if (scaleDragStart === null) scaleDragStart = snapshotNow();   // 拖动开始记快照
      applyLayoutScale(parseFloat(this.value) || 1);
    });
    scaleSlider.addEventListener("change", function () {
      // 拖动结束：把整个拖动记为一个撤销点并保存
      if (scaleDragStart) {
        pushUndo("scale", scaleDragStart);
        scaleDragStart = null;
      }
      saveLayoutMemory();
    });
  }
  // 关闭页面前确保最后状态已保存
  window.addEventListener("beforeunload", function () {
    if (saveMemoryTimer) { clearTimeout(saveMemoryTimer); saveMemoryTimer = null; }
    saveLayoutMemory();
  });

  // 双击判定：180ms 内的第二次点击视作双击，单击延迟降低
  let clickTimer = null;
  cy.on("mouseover", "node", function (evt) {
    if (evt.target.data("kind") !== "gate") evt.target.addClass("hovered");
  });
  cy.on("mouseout", "node", function (evt) {
    evt.target.removeClass("hovered");
  });
  cy.on("tap", "node", function (evt) {
    const node = evt.target;
    if (node.data("kind") === "gate") { return; }
    if (connectSource !== null) { return; }   // 连接模式下的点击由连接流程处理
    const id = node.id();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; } // 双击交给 dbltap
    clickTimer = setTimeout(function () {
      clickTimer = null;
      state.selected = id;
      renderPanel(id);
      focusHero(id);
    }, 180);
  });
  cy.on("dbltap", "node", function (evt) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    const node = evt.target;
    if (node.data("kind") === "gate") { return; }
    openNodePage(node.id());
  });
  cy.on("tap", function (evt) {
    if (evt.target === cy) {
      if (connectSource !== null) { cancelConnect(); return; }
      if (focusedId) { clearFocus(); }
    }
  });
  $("btn-focus-off").addEventListener("click", clearFocus);
  $("btn-layout-toggle").addEventListener("click", function () {
    currentLayout = currentLayout === "cloud" ? "logical" : "cloud";
    this.textContent = currentLayout === "cloud" ? "🌌 星云图" : "🧠 逻辑图";
    stopFlowAnimation();
    runLayout(currentLayout);   // 该布局有存档则恢复，无存档才重新计算
  });

  // ---------- 控件 ----------
  // 标注模式三态切换：num（仅编号）→ full（编号+短名）→ off（隐藏）→ num
  function applyLabelModeButton() {
    const btn = $("btn-label-mode");
    if (!btn) return;
    btn.textContent = state.labelMode === "num" ? "🔢 标注：仅编号"
      : state.labelMode === "full" ? "🔢 标注：编号+短名"
      : "🔢 标注：隐藏";
  }
  function cycleLabelMode() {
    state.labelMode = state.labelMode === "num" ? "full" : state.labelMode === "full" ? "off" : "num";
    numStore.data.labelMode = state.labelMode;
    numStore.save();
    applyLabelMode();
    applyLabelModeButton();
  }
  // 自定义编号（右键球菜单）
  function setCustomNum(id) {
    const cur = state.customNum[id] !== undefined ? state.customNum[id] : getNum(id);
    const val = prompt("为这个球设置编号（留空则删除自定义、恢复初始编号）：", cur);
    if (val === null) return;      // 取消
    const trimmed = String(val).trim();
    if (trimmed === "") {
      if (state.customNum[id] !== undefined) {
        delete state.customNum[id];
      }
    } else {
      state.customNum[id] = trimmed;
    }
    numStore.save();
    applyLabelMode();
    // 更新侧栏若正显示该节点
    if (state.selected === id) renderPanel(id);
  }
  function resetAllNums() {
    if (!Object.keys(state.customNum).length) return;
    if (!confirm("清除全部自定义编号，恢复按教材顺序的初始编号？")) return;
    state.customNum = {};
    numStore.data.customNum = {};
    numStore.save();
    applyLabelMode();
  }

  function refreshChips() {
    const chip = function (id, on) {
      const el = $(id);
      if (el) el.classList.toggle("on", on);
    };
    chip("chip-def", state.showDef);
    chip("chip-ex", state.showEx);
    chip("chip-user", state.showUser);
    chip("chip-aux", state.showAux);
  }
  // 所有过滤控件：只改显隐，不重建
  $("toggle-def").addEventListener("change", function () { state.showDef = this.checked; refreshChips(); applyFilters(); });
  $("toggle-ex").addEventListener("change", function () { state.showEx = this.checked; refreshChips(); applyFilters(); });
  $("toggle-user").addEventListener("change", function () { state.showUser = this.checked; refreshChips(); applyFilters(); });
  $("toggle-aux").addEventListener("change", function () { state.showAux = this.checked; refreshChips(); applyFilters(); });
  $("toggle-equiv").addEventListener("change", function () { state.showEquiv = this.checked; applyFilters(); });
  $("toggle-impl").addEventListener("change", function () { state.showImpl = this.checked; applyFilters(); });
  $("toggle-joint").addEventListener("change", function () { state.showJoint = this.checked; applyFilters(); });
  $("toggle-custom").addEventListener("change", function () { state.showCustom = this.checked; applyFilters(); });

  // 学科切换
  function buildSubjectToggles() {
    const box = $("subj-toggles");
    const btns = [];
    SUBJECTS.forEach(function (s) {
      const b = document.createElement("button");
      b.className = "subj-toggle";
      b.style.color = s.color;
      b.textContent = s.label;
      b.dataset.sid = s.id;
      b.addEventListener("click", function () { state.view = s.id; applyView(); buildSubjectToggles(); });
      btns.push(b);
    });
    // 自建学科（用户创建的）
    userSubjects.data.forEach(function (s) {
      const b = document.createElement("button");
      b.className = "subj-toggle";
      b.style.color = s.color;
      b.textContent = s.label;
      b.dataset.sid = s.id;
      b.addEventListener("click", function () { state.view = s.id; applyView(); buildSubjectToggles(); });
      // 右键自建学科：重命名 / 换色 / 删除
      b.addEventListener("contextmenu", function (ev) {
        ev.preventDefault();
        showCtxMenu(ev.clientX, ev.clientY, [
          { label: "✏ 重命名", action: function () { renameUserSubject(s.id); } },
          { label: "🎨 更换颜色", action: function () { recolorUserSubject(s.id); } },
          { label: "🗑 删除学科", danger: true, action: function () { deleteUserSubject(s.id); } }
        ]);
      });
      btns.push(b);
    });
    const ball = document.createElement("button");
    ball.className = "subj-toggle";
    ball.textContent = "🌐 合并大网";
    ball.dataset.sid = "all";
    ball.addEventListener("click", function () { state.view = "all"; applyView(); buildSubjectToggles(); });
    btns.push(ball);
    // 「＋」新建学科按钮
    const plus = document.createElement("button");
    plus.className = "subj-toggle subj-plus";
    plus.textContent = "＋";
    plus.title = "新建学科";
    plus.addEventListener("click", createSubjectDialog);
    btns.push(plus);
    box.innerHTML = "";
    btns.forEach(function (b) {
      b.classList.toggle("on", b.dataset.sid === state.view);
      box.appendChild(b);
    });
  }
  // 新建学科对话框（名称 + 颜色）
  function createSubjectDialog() {
    const label = prompt("新学科名称：", "");
    if (label === null) return;
    const trimmed = String(label).trim();
    if (!trimmed) return;
    const colorInput = prompt("学科颜色（十六进制，留空用默认紫）：", "#9141ac");
    let color = String(colorInput || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#9141ac";
    const s = addUserSubject(trimmed, color);
    state.view = s.id;
    applyView();
    buildSubjectToggles();
    flashStatus("已创建学科「" + s.label + "」（可在导入节点时归属到此学科）");
  }
  function renameUserSubject(id) {
    const s = subjects[id];
    if (!s) return;
    const val = prompt("新名称：", s.label);
    if (val === null) return;
    const trimmed = String(val).trim();
    if (!trimmed) return;
    s.label = trimmed;
    const idx = userSubjects.data.findIndex(function (x) { return x.id === id; });
    if (idx >= 0) userSubjects.data[idx].label = trimmed;
    userSubjects.save();
    buildSubjectToggles();
    if (state.view === id) {
      $("view-label").textContent = "视图：" + trimmed;
    }
  }
  function recolorUserSubject(id) {
    const s = subjects[id];
    if (!s) return;
    const val = prompt("颜色（十六进制）：", s.color);
    if (val === null) return;
    const trimmed = String(val).trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) { flashStatus("颜色格式无效，未修改"); return; }
    s.color = trimmed;
    const idx = userSubjects.data.findIndex(function (x) { return x.id === id; });
    if (idx >= 0) userSubjects.data[idx].color = trimmed;
    userSubjects.save();
    buildSubjectToggles();
  }
  function deleteUserSubject(id) {
    const s = subjects[id];
    if (!s) return;
    const count = userNodes.order.filter(function (nid) {
      return (userNodes.data[nid].subjectId || "user") === id;
    }).length;
    const msg = count
      ? "确定删除学科「" + s.label + "」？其 " + count + " 个节点将迁回「我的节点」通用分组。"
      : "确定删除学科「" + s.label + "」？";
    if (!confirm(msg)) return;
    pushUndo("subject");
    removeUserSubject(id);
    buildSubjectToggles();
    flashStatus("已删除学科（节点已迁回通用分组）");
  }
  buildSubjectToggles();

  // 搜索：防抖 + 显隐过滤（不重建图）
  $("search").addEventListener("input", function () {
    const q = this.value.trim();
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    // 彩蛋：搜索框输入 bananer 触发横幅
    if (q && q.toLowerCase() === "bananer") {
      showEasterEgg();
      return;
    }
    searchTimer = setTimeout(function () {
      searchTimer = null;
      if (state.query === q) return;
      state.query = q;
      if (q) {
        applyFilters();      // 恢复当前勾选项的显隐 + 搜索淡出加亮（内部已调用 applySearch）
      } else {
        // 清空：恢复过滤态并取消加亮
        searchHits.clear();
        applyFilters();
        if (focusedId) { applyFocusClasses(); }
      }
    }, 180);
  });

  // 彩蛋横幅：搜索框输入 bananer 触发，3 秒后自动消失
  let eggTimer = null;
  function showEasterEgg() {
    if (eggTimer) { clearTimeout(eggTimer); eggTimer = null; }
    let egg = document.getElementById("easter-egg-banner");
    if (!egg) {
      egg = document.createElement("div");
      egg.id = "easter-egg-banner";
      egg.style.cssText =
        "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;" +
        "font-size:28px;font-weight:bold;color:#f2c94c;background:rgba(26,95,180,0.92);" +
        "padding:24px 40px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.35);" +
        "pointer-events:none;white-space:nowrap;";
      document.body.appendChild(egg);
    }
    egg.textContent = "🐒 Bananer：i ❤ CQU 🍌";
    egg.style.display = "";
    eggTimer = setTimeout(function () {
      egg.style.display = "none";
      eggTimer = null;
    }, 3000);
  }

  // 标注模式按钮 / 恢复初始编号按钮
  const btnLabelMode = $("btn-label-mode");
  if (btnLabelMode) btnLabelMode.addEventListener("click", cycleLabelMode);
  const btnResetNum = $("btn-reset-num");
  if (btnResetNum) btnResetNum.addEventListener("click", resetAllNums);

  // 我的连接管理面板
  const btnManageCustom = $("btn-manage-custom");
  if (btnManageCustom) btnManageCustom.addEventListener("click", function () { toggleCustomManager(); });
  const btnMgrClose = $("custom-mgr-close");
  if (btnMgrClose) btnMgrClose.addEventListener("click", function () { toggleCustomManager(false); });
  const btnMgrClear = $("custom-mgr-clear");
  if (btnMgrClear) btnMgrClear.addEventListener("click", function () {
    if (!Object.keys(customEdges.data).length) return;
    if (!confirm("确定删除全部手动建立的连接？")) return;
    pushUndo("custom-edge");
    customEdges.data = {};
    customEdges.save();          // 立即持久化
    syncCustomEdges();
    refreshCustomManager();
    flashStatus("已清空全部连接（已自动保存）");
  });

  // ---------- 导入节点弹窗（单个 / 批量） ----------
  const importModal = {
    open: function (tab) {
      $("import-modal").classList.remove("hidden");
      this.setTab(tab || "single");
      populateSubjectOptions();
      this.msg("");
      $("imp-label").focus();
    },
    close: function () { $("import-modal").classList.add("hidden"); },
    setTab: function (t) {
      const single = t === "single";
      $("tab-single").classList.toggle("on", single);
      $("tab-batch").classList.toggle("on", !single);
      $("import-single").classList.toggle("hidden", !single);
      $("import-batch").classList.toggle("hidden", single);
    },
    msg: function (text, cls) {
      $("import-msg").textContent = text;
      $("import-msg").className = "import-msg " + (cls || "");
    },
    msg2: function (text, cls) {
      $("import-msg2").textContent = text;
      $("import-msg2").className = "import-msg " + (cls || "");
    }
  };
  function makeUserNodeId(label) {
    let base = "U_" + String(label || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "NODE";
    let id = base, i = 1;
    while (allNodes[id] !== undefined) { id = base + "_" + (++i); }
    return id;
  }
  function validateUserNode(raw) {
    if (!raw || typeof raw !== "object") return { error: "每个节点必须是对象" };
    const label = String(raw.label || "").trim();
    if (!label) return { error: "缺少 label（短名）" };
    const statement = String(raw.statement || "").trim();
    if (!statement) return { error: "缺少 statement（陈述）" };
    const sid = raw.subjectId && subjects[raw.subjectId] ? raw.subjectId : "user";
    return {
      node: {
        id: makeUserNodeId(label),
        kind: "theorem",
        subjectId: sid,
        label: label,
        title: String(raw.title || "").trim() || label,
        statement: statement,
        proof: String(raw.proof || "").trim(),
        ref: String(raw.ref || "").trim(),
        note: String(raw.note || "").trim()
      },
      error: null
    };
  }
  function submitSingle() {
    const raw = {
      label: $("imp-label").value,
      title: $("imp-title").value,
      statement: $("imp-statement").value,
      proof: $("imp-proof").value,
      ref: $("imp-ref").value,
      subjectId: $("imp-subject").value
    };
    const r = validateUserNode(raw);
    if (r.error) { importModal.msg(r.error, "err"); return; }
    pushUndo("user-node");
    if (addUserNode(r.node)) {
      importModal.msg("已生成新球：" + r.node.label + "（编号 " + getNum(r.node.id) + "）", "ok");
      $("imp-label").value = ""; $("imp-title").value = ""; $("imp-statement").value = "";
      $("imp-proof").value = ""; $("imp-ref").value = "";
    } else {
      importModal.msg("生成失败（id 冲突）", "err");
    }
  }
  function submitBatch() {
    const text = $("imp-batch-json").value.trim();
    let arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      importModal.msg2("JSON 解析失败：" + e.message, "err");
      return;
    }
    if (!Array.isArray(arr)) { importModal.msg2("请粘贴 JSON 数组（以 [ 开头）", "err"); return; }
    if (!arr.length) { importModal.msg2("数组为空", "err"); return; }
    const batchSubject = $("imp-batch-subject").value || "user";
    const errors = [];
    const okNodes = [];
    arr.forEach(function (raw, i) {
      if (typeof raw === "object" && raw !== null && !raw.subjectId) raw.subjectId = batchSubject;
      const r = validateUserNode(raw);
      if (r.error) { errors.push("第 " + (i + 1) + " 条：" + r.error); return; }
      okNodes.push(r.node);
    });
    if (errors.length && !okNodes.length) {
      importModal.msg2(errors.slice(0, 3).join("；") + (errors.length > 3 ? " 等" : ""), "err");
      return;
    }
    pushUndo("user-node");
    let added = 0;
    okNodes.forEach(function (node) { if (addUserNode(node)) added++; });
    const msg = "成功生成 " + added + " 个球" + (errors.length ? "；" + errors.length + " 条失败（" + errors[0] + "）" : "");
    importModal.msg2(msg, errors.length ? "ok" : "ok");
    if (added && !errors.length) $("imp-batch-json").value = "";
  }
  function populateSubjectOptions() {
    const singleSel = $("imp-subject");
    const batchSel = $("imp-batch-subject");
    const opts = ['<option value="user">我的节点（通用分组）</option>'];
    userSubjects.data.forEach(function (s) {
      opts.push('<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label) + "</option>");
    });
    const html = opts.join("");
    if (singleSel) singleSel.innerHTML = html;
    if (batchSel) batchSel.innerHTML = html;
  }

  const btnImportNode = $("btn-import-node");
  if (btnImportNode) btnImportNode.addEventListener("click", function () { importModal.open("single"); });
  const btnImportClose = $("import-close");
  if (btnImportClose) btnImportClose.addEventListener("click", function () { importModal.close(); });
  const tabSingle = $("tab-single");
  if (tabSingle) tabSingle.addEventListener("click", function () { importModal.setTab("single"); });
  const tabBatch = $("tab-batch");
  if (tabBatch) tabBatch.addEventListener("click", function () { importModal.setTab("batch"); });
  const impSubmit = $("imp-submit");
  if (impSubmit) impSubmit.addEventListener("click", submitSingle);
  const impBatchSubmit = $("imp-batch-submit");
  if (impBatchSubmit) impBatchSubmit.addEventListener("click", submitBatch);
  // 点遮罩关闭
  $("import-modal").addEventListener("click", function (ev) {
    if (ev.target === this) importModal.close();
  });
  // Esc 关闭
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") {
      const m = $("import-modal");
      if (m && !m.classList.contains("hidden")) importModal.close();
    }
  });

  // ---------- 启动 ----------
  // 彩蛋：按 F12 打开控制台可见
  try {
    console.log(
      "%c🐒 Bananer：i ❤ CQU 🍌",
      "font-size:22px;font-weight:bold;color:#f2c94c;background:#1a5fb4;padding:8px 16px;border-radius:8px;"
    );
  } catch (e) { /* 低调藏好 */ }
  syncSlider();
  renderCustomManager();         // 更新按钮上的连接计数
  applyLabelModeButton();
  applyView();
  refreshNotedBadges();
  // 从详情页切回来时刷新笔记角标
  window.addEventListener("focus", refreshNotedBadges);
  window.__KG = { cy: cy, allNodes: allNodes, allEdges: allEdges, allJoints: allJoints, subjects: subjects };
})();
