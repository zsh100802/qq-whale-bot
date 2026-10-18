// 记忆 + 调度自测：验证「重启不丢」「到点只说一次」
//   node test/memory-scheduler-test.mjs

import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.js";
import { MemoryStore } from "../src/memory.js";
import { startScheduler } from "../src/scheduler.js";
import { WhaleBot } from "../src/bot.js";

const memFile = join(ROOT, "data", "test-memory.json");
const cfgFile = join(ROOT, "data", "test-schedule.json");
let failed = 0;

function check(name, ok, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}

// ---- 1. 记忆写入 + 重载 ----
if (existsSync(memFile)) rmSync(memFile);
{
  const m1 = new MemoryStore(memFile);
  m1.push("888", { speaker: "阿泽", text: "小鲸你好" });
  m1.push("888", { speaker: "深小鲸", text: "哼。", isSelf: true });
  m1.save();

  const m2 = new MemoryStore(memFile);
  const list = m2.recent("888", 10);
  check("记忆落盘后重载", list.length === 2 && list[0].text === "小鲸你好", `条数=${list.length}`);
  check("自己说的话被标记为 isSelf", list[1].isSelf === true);
  check("不存在的群返回空", m2.recent("999", 10).length === 0);
}

// ---- 2. 调度：同一分钟只发一次，且写回记忆 ----
writeFileSync(
  cfgFile,
  JSON.stringify({ messages: [{ at: "00:00", kind: "test", prompt: "测试主动发言" }] }, null, 2),
  "utf8"
);
{
  const mem = new MemoryStore(memFile);
  const bot = new WhaleBot();
  const sends = [];
  // 2026-09-27T16:00:00Z == 2026-09-28 00:00 Asia/Shanghai
  const fixedNow = () => new Date("2026-09-27T16:00:00Z");

  const sched = startScheduler({
    bot,
    memory: mem,
    send: (gid, text) => sends.push({ gid, text }),
    groups: ["888"],
    configPath: cfgFile,
    intervalMs: 50,
    now: fixedNow,
    log: () => {},
  });

  await sched.tick();
  await sched.tick();
  await sched.tick();
  sched.stop();

  check("到点主动发言只触发一次", sends.length === 1, `实际=${sends.length}`);
  check("发言内容非空", !!sends[0]?.text, sends[0]?.text);
  check("已记录当天已发", mem.getScheduleDone("test") === "2026-09-28", mem.getScheduleDone("test"));

  // 模拟重启：新实例读到已发标记，不该重复发
  mem.save();
  const mem2 = new MemoryStore(memFile);
  check("重启后仍记得今天发过", mem2.getScheduleDone("test") === "2026-09-28");
}

// ---- 3. 上下文隔离：不同群的记忆不串 ----
{
  const mem = new MemoryStore(memFile);
  mem.push("A群", { speaker: "甲", text: "A群的话" });
  mem.push("B群", { speaker: "乙", text: "B群的话" });
  const a = mem.recent("A群", 5).map((m) => m.text);
  check("群上下文不串台", a.length === 1 && a[0] === "A群的话", JSON.stringify(a));
}

// 清理
for (const f of [memFile, memFile + ".tmp", cfgFile]) {
  try {
    rmSync(f);
  } catch {}
}

console.log(failed ? `\n❌ ${failed} 项失败` : "\n✅ 记忆与调度验证通过");
process.exit(failed ? 1 : 0);
