// 常驻调度：到点主动说话（早安/晚安），发过一次当天不再发
// 这是「它一直醒着」和「它只在被叫时才醒」的分界线。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";

export const DEFAULT_SCHEDULE = join(ROOT, "config", "schedule.json");
const TZ = process.env.WHALE_TZ ?? "Asia/Shanghai";

function dateKeyInTz(d = new Date()) {
  return d.toLocaleDateString("sv-SE", { timeZone: TZ }); // YYYY-MM-DD
}

function hhmmInTz(d = new Date()) {
  return d.toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false }).slice(0, 5); // HH:MM
}

/**
 * @param {{
 *  bot: import('./bot.js').WhaleBot,
 *  memory: import('./memory.js').MemoryStore,
 *  send: (groupId: string, text: string) => void,
 *  groups: string[],
 *  configPath?: string,
 *  intervalMs?: number,
 *  log?: (...a:any)=>void,
 *  now?: () => Date
 * }} opts
 */
export function startScheduler(opts) {
  const {
    bot,
    memory,
    send,
    groups,
    configPath = DEFAULT_SCHEDULE,
    intervalMs = 20000,
    log = console.log,
    now = () => new Date(),
  } = opts;

  if (!existsSync(configPath)) {
    log(`[schedule] 没有配置文件 ${configPath}，不启用主动消息`);
    return null;
  }
  if (!groups.length) {
    log("[schedule] 没有配置目标群（WHALE_GROUPS 为空），不启用主动消息");
    return null;
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    log(`[schedule] 配置解析失败：${err.message}`);
    return null;
  }
  const items = (cfg.messages ?? []).filter((m) => m?.at && m?.prompt);
  log(`[schedule] 已启用：${items.map((m) => `${m.at} ${m.kind ?? ""}`).join(" / ") || "（空）"}`);

  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const d = now();
      const today = dateKeyInTz(d);
      const hhmm = hhmmInTz(d);

      for (const item of items) {
        if (item.at !== hhmm) continue;
        const kind = item.kind ?? item.at;
        if (memory.getScheduleDone(kind) === today) continue; // 今天发过了

        for (const gid of groups) {
          try {
            const recent = memory.recent(gid, 12);
            const { text, model, ms } = await bot.generateProactive(item.prompt, { recent });
            send(gid, text);
            memory.push(gid, { speaker: bot.name, text, isSelf: true });
            memory.setScheduleDone(kind, today);
            log(`[schedule] 群 ${gid} 主动发言：${text}  [${model} ${ms}ms]`);
          } catch (err) {
            log(`[schedule] 群 ${gid} 发言失败：${err.message}`);
          }
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
