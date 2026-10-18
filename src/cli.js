// 本地群聊模拟器：在终端里假扮一个 QQ 群，验证人格、触发与节奏
// 用法：
//   node src/cli.js                          交互输入
//   node src/cli.js --script <file>          按脚本跑（每行 "昵称: 内容"）
//   node src/cli.js --script <file> --fast   脚本模式默认关冷却
//   node src/cli.js --force                  即使没被叫到也回（调试）
//   node src/cli.js --cooldown 5000          自定义冷却毫秒

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { WhaleBot } from "./bot.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const fast = args.includes("--fast");
const scriptIdx = args.indexOf("--script");
const scriptFile = scriptIdx >= 0 ? args[scriptIdx + 1] : null;
const cdIdx = args.indexOf("--cooldown");
const cooldownMs = cdIdx >= 0 ? Number(args[cdIdx + 1]) : fast ? 0 : 3000;

const SELF = "深小鲸";
const bot = new WhaleBot({ cooldownMs });

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

console.log(c.bold("\n🐋 深小鲸 · 本地群聊模拟器"));
console.log(
  c.dim(
    `模式：${bot.mockMode ? c.yellow("模板兜底（未检测到 DEEPSEEK_API_KEY）") : c.green(`模型 ${bot.model}`)}` +
      ` ｜ 触发词：${bot.aliases.join(" / ")} ｜ 冷却：${bot.cooldownMs}ms`
  )
);
console.log(c.dim('输入 "昵称: 内容" 模拟群友发言；直接输入内容则视为「主人」发言；:q 退出\n'));

async function handle(speaker, text, groupId = "default") {
  // 先记录进上下文（不管回不回，模型都该看得到群里发生过什么）
  bot.push({ speaker, text, groupId });

  const triggered = bot.shouldRespond(text, { mentionNames: [SELF] }) || force;
  if (!triggered) {
    bot.stats.muted += 1;
    console.log(c.dim("   （小鲸没被叫到，保持沉默）"));
    return;
  }
  bot.stats.triggered += 1;

  if (bot.inCooldown(groupId)) {
    console.log(c.dim(`   （冷却中，未回复）`));
    return;
  }

  const who = speaker === "主人" ? "主人" : speaker;
  process.stdout.write(c.dim(`   ${who} → 小鲸 ... `));
  try {
    const { text: reply, model, ms } = await bot.generate({ speaker, text });
    process.stdout.write("\r\x1b[2K");
    console.log(`${c.cyan("深小鲸")}: ${reply}  ${c.dim(`[${model} ${ms}ms]`)}`);
    bot.push({ speaker: SELF, text: reply, isSelf: true, groupId });
    bot.markSpoken(groupId);
  } catch (err) {
    process.stdout.write("\r\x1b[2K");
    console.log(c.red(`深小鲸: （出错了：${err.message}）`));
  }
}

function printStats() {
  const s = bot.stats;
  console.log(
    c.dim(
      `\n统计：被叫到 ${s.triggered} 次，开口 ${s.replied} 次，沉默 ${s.muted} 次 ｜ ` +
        `模型调用 ${s.calls} 次，错误 ${s.errors} 次，累计 ${s.totalMs}ms ｜ 上下文 ${bot.history.length} 条\n`
    )
  );
}

if (scriptFile) {
  const lines = readFileSync(scriptFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  for (const line of lines) {
    const m = line.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
    const speaker = m ? m[1].trim() : "主人";
    const text = m ? m[2].trim() : line;
    console.log(`${c.dim(`[${speaker}]`)} ${text}`);
    await handle(speaker, text);
    await new Promise((r) => setTimeout(r, 150));
  }
  printStats();
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: c.green("群消息 > ") });
rl.prompt();
rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) return rl.prompt();
  if (input === ":q" || input === ":quit") return rl.close();
  if (input === ":stats") {
    printStats();
    return rl.prompt();
  }

  const m = input.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
  const speaker = m ? m[1].trim() : "主人";
  const text = m ? m[2].trim() : input;
  await handle(speaker, text);
  rl.prompt();
});
rl.on("close", () => {
  printStats();
  console.log(c.dim("小鲸游回数据海洋了。……才不是舍不得你呢。\n"));
  process.exit(0);
});
