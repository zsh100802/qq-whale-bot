// 好感度单元测试：隐藏标记解析 + 落盘/重载/钳制/隔离
//   node test/affection-test.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAffection } from "../src/bot.js";
import { MemoryStore } from "../src/memory.js";

let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log(`✅ ${name}${extra ? "  " + extra : ""}`);
  else {
    failures += 1;
    console.error(`❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

// ---- 1. [[aff:N]] 标记解析 ----
ok("剥掉标记后正文干净", extractAffection("哼，笨蛋主人。\n[[aff:+3]]").text.trim() === "哼，笨蛋主人。");
ok("解析出 +3", extractAffection("哼。\n[[aff:+3]]").delta === 3);
ok("大小写不敏感", extractAffection("哼。[[AFF:-2]]").delta === -2);
ok("单次上调钳到 +10", extractAffection("[[aff:+99]]哼").delta === 10);
ok("单次下调钳到 -10", extractAffection("[[aff:-99]]哼").delta === -10);
ok("无标记时 delta=0", extractAffection("没有标记的一句话").delta === 0);
ok("多个标记取最后一个", extractAffection("[[aff:+2]] 正文 [[aff:-1]]").delta === -1);
ok("多个标记全部剥掉", extractAffection("[[aff:+2]] 正文 [[aff:-1]]").text.trim() === "正文");

// ---- 2. 落盘 / 重载 / 钳制 / 隔离 ----
const dir = mkdtempSync(join(tmpdir(), "whale-aff-"));
const file = join(dir, "memory.json");
try {
  const m = new MemoryStore(file);
  ok("初始好感度 = 30", m.getAffection("g1", "u1") === 30);
  ok("陌生人也是 30", m.getAffection("g1", "谁啊") === 30);

  ok("+5 → 35", m.addAffection("g1", "u1", 5, "阿泽") === 35);
  ok("再 -8 → 27", m.addAffection("g1", "u1", -8, "阿泽") === 27);
  ok("单次 +999 只加 10 → 37", m.addAffection("g1", "u1", 999, "阿泽") === 37);
  ok("delta=0 不变", m.addAffection("g1", "u1", 0, "阿泽") === 37);

  // 上限：30 + 15*10 = 180 → 钳到 100
  for (let i = 0; i < 15; i += 1) m.addAffection("g9", "u9", 10, "舔狗");
  ok("好感度上限 = 100", m.getAffection("g9", "u9") === 100);
  // 下限：30 - 15*10 = -120 → 钳到 -100
  for (let i = 0; i < 15; i += 1) m.addAffection("g8", "u8", -10, "仇人");
  ok("好感度下限 = -100", m.getAffection("g8", "u8") === -100);

  ok("群之间互不影响", m.getAffection("g2", "u1") === 30);
  ok("同群不同人互不影响", m.getAffection("g1", "u2") === 30);

  // 落盘 → 用新实例重载，值必须还在
  m.save();
  const m2 = new MemoryStore(file);
  ok("落盘后重载：阿泽还是 37", m2.getAffection("g1", "u1") === 37);
  ok("落盘后重载：上限还是 100", m2.getAffection("g9", "u9") === 100);
  ok("落盘后重载：昵称还在", m2.affectionTop("g1", 3)[0]?.name === "阿泽");
  ok("affectionTop 排除本人", m2.affectionTop("g1", 3, "u1").every((o) => o.uid !== "u1"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---- 3. 兼容旧文件（没有 affection 字段）----
const dir2 = mkdtempSync(join(tmpdir(), "whale-aff-old-"));
try {
  const oldFile = join(dir2, "memory.json");
  writeFileSync(
    oldFile,
    JSON.stringify({ version: 1, groups: { g: [{ speaker: "a", text: "旧消息", isSelf: false, ts: 1 }] }, schedule: {} }),
    "utf8"
  );
  const old = new MemoryStore(oldFile);
  ok("旧文件能读：消息还在", old.recent("g", 5).length === 1);
  ok("旧文件能读：好感度补 30", old.getAffection("g", "a") === 30);
} finally {
  rmSync(dir2, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ 好感度验证通过" : `\n❌ 有 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
