// ============================================================
// 学科数据注册表（manifest）
// 新增一个学科：在 KG_SUBJECTS 数组里加一项，并创建对应数据文件 data/<id>.js
// 跨学科联合蕴含边（joints）既可以在各学科文件里声明，也可以在这里集中声明。
// ============================================================
// 注册器：每个学科数据文件末尾调用 window.registerSubject(window.KG_DATA)，
// 把数据收集到 window.__KG_REGISTRY，避免多个学科文件相互覆盖全局变量。
window.__KG_REGISTRY = [];
window.registerSubject = function (data) {
  window.__KG_REGISTRY.push(data);
};
window.KG_SUBJECTS = [
  {
    id: "topology",                    // 数据文件名 data/topology.js
    label: "拓扑学",                    // 显示名
    color: "#1a5fb4",                  // 学科主色
    file: "data/topology.js"
  },
  {
    id: "analysis",
    label: "数学分析",
    color: "#26a269",
    file: "data/analysis.js"
  },
  {
    id: "algebra",
    label: "高等代数",
    color: "#c01c28",
    file: "data/algebra.js"
  }
];
