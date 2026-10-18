// 环境自检：一条命令告诉你「哪一环没接上」
//   node src/selfcheck.mjs
//
// 不会发送任何 QQ 消息，也不会打印 Key 内容。

import { loadEnv, ROOT } from "./env.js";
loadEnv();

import { existsSync } from "node:fs";
import { join } from "node:path";
import { synthesize } from "./tts.js";

const ok = (s) => `✅ ${s}`;
const bad = (s) => `❌ ${s}`;
const warn = (s) => `⚠️  ${s}`;

let fails = 0;
const fail = (msg) => {
  fails++;
  console.log(bad(msg));
};

console.log("\n🐋 深小鲸环境自检\n" + "─".repeat(44));

// 1. Node
const major = Number(process.versions.node.split(".")[0]);
if (major >= 20) console.log(ok(`Node ${process.versions.node}`));
else fail(`Node ${process.versions.node} 太旧，需要 >= 20`);

// 2. 配置文件
const envFile = join(ROOT, ".env.local");
if (existsSync(envFile)) console.log(ok(".env.local 存在"));
else console.log(warn(".env.local 不存在，将使用系统环境变量或模板兜底"));

// 3. 模型 Key（只报长度，不打印内容）
const key = process.env.DEEPSEEK_API_KEY ?? "";
if (key) console.log(ok(`DEEPSEEK_API_KEY 已设置（长度 ${key.length}）`));
else console.log(warn("没有 DEEPSEEK_API_KEY —— 能跑，但只会说模板话术"));

// 4. 协议端地址与连通性
const wsUrl = process.env.ONEBOT_WS ?? "ws://127.0.0.1:3001";
const token = process.env.ONEBOT_TOKEN ?? "";
console.log(`\n协议端地址：${wsUrl}${token ? "（带 token）" : "（无 token）"}`);

await new Promise((resolve) => {
  let settled = false;
  const done = (msg, good) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (good) console.log(ok(msg));
    else fail(msg);
    try {
      ws.close();
    } catch {}
    resolve();
  };

  let ws;
  try {
    ws = new WebSocket(wsUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  } catch (err) {
    return done(`地址格式不对：${err.message}`, false);
  }

  const timer = setTimeout(() => done("连接超时（5 秒）——协议端没起来，或端口/防火墙不对", false), 5000);
  ws.addEventListener("open", () => done("协议端连接成功", true));
  ws.addEventListener("error", () => done("连接失败——检查协议端是否运行、端口是否一致、token 是否正确", false));
});

// 5. 语音合成
console.log("\n语音合成测试……");
try {
  const v = await synthesize("哼，笨蛋主人，自检开始。");
  const sec = v.backend === "edge" ? (v.bytes * 8) / 48000 : v.bytes / (22050 * 2 * 2);
  console.log(ok(`语音可用：${v.backend}，${v.ms}ms，约 ${sec.toFixed(1)} 秒，${(v.bytes / 1024).toFixed(0)}KB`));
} catch (err) {
  fail(`语音合成失败：${err.message}`);
}

// 6. 群白名单
const groups = (process.env.WHALE_GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (groups.length) console.log(ok(`群白名单：${groups.join(", ")}`));
else console.log(warn("WHALE_GROUPS 为空 —— 它会在所有群里说话，强烈建议填"));

// 7. 定时配置
const schedOn = process.env.WHALE_SCHEDULE !== "0";
const cfg = join(ROOT, "config", "schedule.json");
if (schedOn && existsSync(cfg)) console.log(ok("定时主动发言：已启用（config/schedule.json）"));
else if (!schedOn) console.log("⏸  定时主动发言：已关闭");
else console.log(warn("启用了定时，但 config/schedule.json 不存在"));

console.log("\n" + "─".repeat(44));
if (fails === 0) {
  console.log("✅ 全部通过，可以双击 启动.bat\n");
  process.exit(0);
} else {
  console.log(`❌ ${fails} 项没通过，按上面的提示修\n`);
  process.exit(1);
}
