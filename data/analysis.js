// ============================================================
// 学科数据模板：数学分析（空，作为接口示例）
// 字段说明见 data/SCHEMA.md 或 topology.js 头注释
// ============================================================
window.KG_DATA = {
  subject: { id: "analysis", label: "数学分析", color: "#26a269" },
  nodes: [
    // 示例格式（复制自 topology.js）：
    // { id: "A1",
    //   kind: "proposition",            // proposition | definition | example
    //   label: "聚点定理",
    //   title: "聚点定理",
    //   statement: "有界无限点集必有聚点。",
    //   proof: "证明位置：教材定理 X.Y（正文）",
    //   ref: "定理 X.Y",
    //   page: 100, pdfPage: 100,
    //   pdfUrl: "your-book.pdf // 指向你自己的教材 PDF#page=100"
    // }
  ],
  edges: [
    // { id: "A_E1", source: "A1", target: "A2", type: "equiv", label: "等价" }
    // { id: "A_I1", source: "A1", target: "A2", type: "impl",  label: "推论" }
  ],
  joints: [
    // { id: "A_J1", sources: ["A1", "A2"], target: "A3", label: "联合蕴含" }
  ]
};

// 注册到全局收集器
window.registerSubject(window.KG_DATA);
