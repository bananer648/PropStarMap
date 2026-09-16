// ============================================================
// 学科数据模板：高等代数（空，作为接口示例）
// 字段说明见 data/SCHEMA.md 或 topology.js 头注释
// ============================================================
window.KG_DATA = {
  subject: { id: "algebra", label: "高等代数", color: "#c01c28" },
  nodes: [],
  edges: [],
  joints: []
};

// 注册到全局收集器
window.registerSubject(window.KG_DATA);
