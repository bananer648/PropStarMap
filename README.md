# 命题星图（PropStarMap）

一个**纯前端、零依赖、离线可用**的数学命题关系图谱。把教材里的定义 / 命题 / 定理 / 特例画成一张可交互的星图：每个命题是一颗星，逻辑关系连成星座，支持复习标注、笔记、自定义连接、手动导入节点、自建学科。

> 默认内置《Introduction to Topological Manifolds》(John M. Lee, GTM 202) 第 2–7 章的拓扑学图谱（238 个节点）。
> 所有第三方库（Cytoscape.js / KaTeX 等）均已本地化，**双击 `index.html` 即可运行**，无需联网、无需服务器、无需构建。

## 如何运行

| 方式 | 说明 |
|---|---|
| 🖱️ 最简单 | 把整个仓库下载（`Code → Download ZIP`）解压，**双击 `index.html`** 即可（Chrome / Edge 体验最佳） |
| 🖥️ 静态服务器 | `python -m http.server` 或 VS Code Live Server（可选，双击已足够） |
| 📦 Windows exe | 见 [Releases](https://github.com/bananer648/PropStarMap/releases)：解压后双击「命题星图.exe」，自动打开浏览器 |

## 仓库布局

```
├── index.html            # 主图页（唯一入口，双击打开）
├── node.html             # 节点详情页（双击球或按钮打开，?id=<节点id>）
├── css/style.css         # 全部样式
├── js/
│   ├── app.js            # 主应用逻辑（布局/交互/过滤/编号/导入/学科管理）
│   └── notes-store.js    # 笔记存储引擎（IndexedDB → localStorage 降级）
├── data/
│   ├── manifest.js       # 学科注册表（KG_SUBJECTS 数组）
│   ├── topology.js       # 拓扑学数据（教材图谱，238 节点示例）
│   ├── analysis.js       # 数学分析（空模板，示例接口）
│   ├── algebra.js        # 高等代数（空模板，示例接口）
│   └── SCHEMA.md         # 数据格式规范（新增学科必读）
├── lib/                  # 本地化第三方库（勿改）
├── pack/                 # exe 打包工具（可选，构建脚本见 pack/build.js）
├── LICENSE               # MIT
└── README.md             # 本文件
```

---

## 快速上手

| 操作 | 方式 |
|---|---|
| 打开 | 双击 `index.html`（或用任意静态服务器） |
| 查看节点 | 单击球 → 右侧详情；双击球 → 新窗口完整详情页 |
| 搜索 | 顶部搜索框（匹配短名 / 标题 / 陈述，支持 LaTeX 原文） |
| 学科切换 | 顶部「拓扑学 / 数学分析 / 高等代数 / 🌐 合并大网」 |
| 布局切换 | 「🧠 逻辑图 / 🌌 星云图」按钮 |
| 过滤 | 「定义 / 特例 / 我的节点 / 证明依赖 / 等价 / 推论 / 联合 / 我的连接」复选框 |
| 复习标注 | 「🔢 标注」按钮三态切换：仅编号 → 编号+短名 → 隐藏 |
| 间距缩放 | 「间距」滑块：绕质心等比放大球间距离（1.00×–3.00×） |
| 撤销 | `Ctrl+Z` 或右键菜单「↶ 撤销」（覆盖布局/编号/连接/导入等，最多 20 步） |

**右键菜单**

- 右键**球**：放大/缩小此球、恢复默认大小、自定义编号、连接另一个球、删除（仅手动导入节点）；
- 右键**空白**：重新布局（唯一会重排球位置的操作）、撤销；
- 右键**灰色虚线**（自定义连接）：删除该连接；
- 右键**自建学科按钮**：重命名 / 换色 / 删除。

---

## 数据格式（给想扩充图谱的你 / AI）

### 1. 新增一个教材学科

1. 复制 `data/algebra.js` 为 `data/<id>.js`，填入数据（字段见 `data/SCHEMA.md`）：
   ```js
   window.KG_DATA = {
     subject: { id: "realanalysis", label: "实分析", color: "#9141ac" },
     nodes: [
       { id: "A1", kind: "proposition", label: "聚点定理", title: "聚点定理",
         statement: "有界无限点集必有聚点。", page: 100, pdfPage: 100,
         pdfUrl: "book.pdf#page=100" }
     ],
     edges: [
       { id: "A_E1", source: "A1", target: "A2", type: "equiv", label: "等价" }
     ],
     joints: []
   };
   window.registerSubject(window.KG_DATA);   // 必须保留
   ```
2. 在 `data/manifest.js` 的 `KG_SUBJECTS` 里注册该学科；
3. 在 `index.html` **和** `node.html` 的 `<script>` 区紧跟其他数据文件后加：
   ```html
   <script src="data/realanalysis.js"></script>
   ```

**字段约定**（详细见 `data/SCHEMA.md`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一（建议学科前缀，如 `T_` / `A_`） |
| `kind` | `definition` \| `proposition` \| `example` | 节点类型（决定颜色） |
| `label` | string | 图上短名 |
| `title` | string | 详情页标题 |
| `statement` | string | 陈述，支持 `$...$` / `$$...$$`（KaTeX） |
| `proof` | string | 证明或证明位置 |
| `page` | number | 印刷页码（**自动编号的依据**：越早出现编号越小） |
| `pdfUrl` | string | 点击跳转原书 PDF 的地址 |

**边类型**：`equiv`（等价，蓝双箭头）/ `impl`（推论，绿单箭头）/ `aux`（证明依赖，灰点线，默认隐藏）/ `joint`（联合蕴含：`joints` 数组，`sources[]` → AND 门 → `target`）。

### 2. 手动导入节点（不改代码）

顶部「＋ 导入节点」→ 单个表单或批量 JSON：

```json
[
  {
    "label": "一致收敛定理",                 // 必填：图上短名
    "statement": "设 $f_n \\Rightarrow f$ 一致收敛，则 $f$ 连续。",  // 必填
    "title": "定理 7.1",                    // 可选
    "proof": "用 $\\varepsilon/3$ 法。",     // 可选
    "ref": "教材 §7.1",                     // 可选
    "subjectId": "u_实分析"                  // 可选：归属自建学科
  }
]
```

- 导入的球固定为 `theorem` 类型（暖橙色），id 自动生成（`U_<短名>`），**编号排在教材节点之后**（不会打乱教材编号）；
- 支持右键删除、参与自定义连接、写笔记、显示在详情页。

### 3. 自建学科

学科切换区末尾的「＋」按钮 → 输入名称与颜色（`#RRGGBB`）。自建学科按钮支持右键重命名 / 换色 / 删除（删除时其节点迁回「我的节点」通用分组）。导入节点时可在「归属学科」下拉里选择。

---

## 本地存储（localStorage 键清单）

所有个人数据都存在浏览器本地，**不联网**。若换浏览器/换电脑需迁移，可导出/导入 JSON。

| 键 | 内容 |
|---|---|
| `math-kg-notes` (IndexedDB) / `kg-note:<id>` | 每个节点的证明笔记（文字 + 图片，见「笔记」） |
| `kg-layout-v1` | 每个学科×布局的球位置、间距倍率、单球大小（关页重开原样恢复） |
| `kg-num-v1` | 标注显示模式 + 自定义编号 |
| `kg-custom-edges-v1` | 手动建立的灰色虚线连接（自动保存） |
| `kg-user-nodes-v1` | 手动导入的节点（自动保存） |
| `kg-user-subjects-v1` | 自建学科列表 |

---

## 笔记（证明过程）

双击球打开详情页，底部「📝 我的证明笔记」：

- **文字**：支持 `$...$` / `$$...$$`，离开 1.2 秒自动保存；
- **图片**：粘贴 / Ctrl+V / 选文件插入（>4096px 自动压缩，单笔记建议 < 4.5MB）；
- **LaTeX 预览**：KaTeX 渲染，错误处红标；
- **导出/导入**：单页或全部笔记 JSON（含 base64 图片），导入可选「合并 / 覆盖」。

---

## 开发与扩展（给开发者 / AI）

- **零构建**：全部为原生 JS，直接改文件、刷新浏览器即可生效（`file://` 协议下可用；个别浏览器对 `localStorage`/`IndexedDB` 有差异，推荐 Chrome/Edge）。
- **主图 API**：`app.js` 最后挂载 `window.__KG = { cy, allNodes, allEdges, allJoints, subjects }`，控制台可直接调试 Cytoscape 实例（如 `__KG.cy.elements().length`）。
- **加功能建议入口**：
  - 纯 UI / 交互：改 `index.html` + `css/style.css` + `js/app.js`；
  - 数据：改 `data/*.js`（节点/边）或 `data/manifest.js`（学科）；
  - 存储：新增键时在 `js/app.js` 顶部按现有 `*Store` 模式仿写，并更新本 README 的键清单。
- **语法校验**：`node --check js/app.js`（需 Node.js）。
- **PDF 跳转**：`data/topology.js` 顶部有 `PDF` 常量与 `pdf()` 辅助函数，换教材时改这一处即可（页码偏移 `+19` 是印刷页→PDF 页的换算）。

## 许可

- **代码与项目结构**：MIT License，见 [LICENSE](LICENSE)；
- **教材内容**：示例拓扑数据（命题表述、定义）版权归原作者所有，仅作学习用途；如权利人要求，可删除 `data/topology.js` 中的示例数据。
