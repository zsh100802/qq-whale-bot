// 深小鲸 · 核心大脑
// 职责：判定该不该开口 → 组装群聊上下文 → 调模型 → 返回一句话
// 零依赖，Node >= 20（用内置 fetch）

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractEmojiTag } from "./emoji.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export function loadPersona() {
  return readFileSync(join(ROOT, "persona", "persona.md"), "utf8");
}

// 模型在回复末尾偷偷输出一行 [[aff:+3]]，程序剥掉它并记进好感度，不会发到群里。
// 注意：正则放在函数里现建，避免 /g 的 lastIndex 跨调用残留。
export function extractAffection(text) {
  const marker = /\[\[\s*aff\s*:\s*([+-]?\d{1,3})\s*\]\]/gi;
  let delta = 0;
  let found = false;
  const rest = String(text ?? "").replace(marker, (_m, n) => {
    const v = Number(n);
    if (Number.isFinite(v)) {
      delta = v;
      found = true;
    }
    return "";
  });
  // 单次最多 ±10，跟 memory.js 里的钳制保持一致
  const clamped = Math.max(-10, Math.min(10, Math.round(delta)));
  return { text: rest, delta: found ? clamped : 0, found };
}

function nowTime() {
  return new Date().toTimeString().slice(0, 8);
}

function cleanName(name) {
  return String(name || "某人").replace(/[\r\n\t]/g, " ").slice(0, 16);
}

function transcriptOf(list) {
  return (
    list.map((m) => `${m.isSelf ? "你" : cleanName(m.speaker)}: ${m.text}`).join("\n") ||
    "（群里还很安静）"
  );
}

export class WhaleBot {
  constructor(opts = {}) {
    this.persona = opts.persona ?? loadPersona();
    this.name = opts.name ?? "小鲸";
    this.aliases = opts.aliases ?? ["小鲸", "深小鲸", "小鲸鱼"];
    // 注意：不要放「机器人」「bot」这类泛词，群里日常提到就会误触发
    this.triggerKeywords = opts.triggerKeywords ?? ["鲸", "深海小鲸"];
    this.contextLimit = opts.contextLimit ?? 20;
    this.cooldownMs = opts.cooldownMs ?? 3000;
    this.lastSpeakAt = new Map(); // 冷却按群隔离：groupId -> ts
    this.apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
    this.model = opts.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    this.temperature = opts.temperature ?? 1.15;
    this.maxTokens = opts.maxTokens ?? 160;
    this.timeoutMs = opts.timeoutMs ?? 25000;

    this.history = []; // { speaker, text, isSelf, groupId, ts }
    this.stats = { calls: 0, errors: 0, totalMs: 0, triggered: 0, replied: 0, muted: 0 };
  }

  get mockMode() {
    return !this.apiKey;
  }

  // ---- 触发判定：被动应答型 ----
  shouldRespond(text, { mentionNames = [] } = {}) {
    const t = String(text || "");
    if (!t.trim()) return false;

    const mentioned = mentionNames.some((n) => n && t.includes(`@${cleanName(n)}`));
    if (mentioned) return true;

    for (const a of this.aliases) if (t.includes(a)) return true;
    for (const k of this.triggerKeywords) if (t.toLowerCase().includes(k.toLowerCase())) return true;

    return false;
  }

  inCooldown(groupId = "default") {
    if (this.cooldownMs <= 0) return false;
    const last = this.lastSpeakAt.get(`${groupId}`) ?? 0;
    return Date.now() - last < this.cooldownMs;
  }

  markSpoken(groupId = "default") {
    this.lastSpeakAt.set(`${groupId}`, Date.now());
    this.stats.replied += 1;
  }

  push({ speaker, text, isSelf = false, groupId = "default" }) {
    this.history.push({
      speaker: cleanName(speaker),
      text: String(text || "").slice(0, 500),
      isSelf,
      groupId,
      ts: Date.now(),
    });
    if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
  }

  // ---- 组装提示词 ----
  _system(recent, extra = "", affection = "") {
    const parts = [
      this.persona,
      "",
      "——— 当前群聊上下文 ———",
      transcriptOf(recent),
      "——— 结束 ———",
      "",
      `现在是 ${nowTime()}。`,
    ];
    if (affection) parts.push("", affection);
    parts.push(extra);
    return parts.join("\n");
  }

  buildMessages(trigger, recent = this.history.slice(-this.contextLimit), affection = "") {
    const extra = [
      "刚刚有人对你说话了，请用深小鲸的语气回一句。",
      "只输出你要说的话本身，不要写昵称前缀。",
    ];
    if (affection) {
      extra.push(
        "说完之后另起一行，输出一个隐藏标记 [[aff:+N]]：N 是 -10~+10 的整数，",
        "代表这次交互让好感度变化多少（被夸/被投喂就调涨，被叫胖/被无视就调降，闲聊写 0）。",
        "这一行会被程序剥掉，不会发到群里，所以正文里别提到它、别解释它。"
      );
    }
    extra.push(
      "如果这句话带着明显情绪，可以在最后另起一行输出 [[emoji:情绪名]]，",
      "情绪名只能是以下之一：开心、生气、傲娇、委屈、卖萌、无语、得意、摸鱼、晚安、早安。",
      "拿不准或没有合适情绪就不要写这个标记。"
    );
    return [
      {
        role: "system",
        content: this._system(recent, extra.join("\n"), affection),
      },
      { role: "user", content: `[触发消息] ${cleanName(trigger.speaker)}: ${trigger.text}` },
    ];
  }

  // 主动发言：没有触发消息，只有一条指令
  buildProactiveMessages(instruction, recent) {
    return [
      {
        role: "system",
        content: this._system(
          recent,
          "没有人叫你，是你要主动开口。请用深小鲸的语气说一句，短、自然、不要像通知。"
        ),
      },
      { role: "user", content: instruction },
    ];
  }

  // ---- 调模型 ----
  async _chat(messages, { temperature, maxTokens } = {}) {
    const t0 = Date.now();
    if (this.mockMode) {
      return {
        text: this.mockReply(messages.at(-1)?.content ?? ""),
        model: "mock",
        ms: Date.now() - t0,
        affectionDelta: 0,
      };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: temperature ?? this.temperature,
          max_tokens: maxTokens ?? this.maxTokens,
          stream: false,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
      }

      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content ?? "";
      // 先把 [[aff:+N]] 记号摘出来，再清理正文；正文里不会留下它
      const { text: body, delta } = extractAffection(raw);
      // 再摘 [[emoji:情绪]] 记号（可能还有 [[aff]] 之后跟着）
      const { text: cleanBody, tag } = extractEmojiTag(body);
      this.stats.calls += 1;
      this.stats.totalMs += Date.now() - t0;
      return {
        text: this.sanitize(cleanBody),
        model: data?.model ?? this.model,
        ms: Date.now() - t0,
        usage: data?.usage,
        affectionDelta: delta,
        emojiTag: tag,
      };
    } catch (err) {
      this.stats.errors += 1;
      const msg = err?.name === "AbortError" ? `超时(${this.timeoutMs}ms)` : err.message;
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(trigger, { recent, affection = "" } = {}) {
    return this._chat(this.buildMessages(trigger, recent, affection));
  }

  async generateProactive(instruction, { recent } = {}) {
    return this._chat(this.buildProactiveMessages(instruction, recent ?? this.history.slice(-12)), {
      temperature: 1.25,
      maxTokens: 120,
    });
  }

  // 清理：去引号、去旁白括号、压掉换行、限长
  sanitize(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/^["“”'']+|["“”'']+$/g, "");
    t = t.replace(/（[^）]{0,20}）/g, "").replace(/\([^)]{0,20}\)/g, "");
    t = t.replace(/\s*\n+\s*/g, " ");
    if (t.length > 120) t = t.slice(0, 120) + "…";
    return t.trim() || "哼。";
  }

  // 没有 API Key 时的本地兜底：验证管道 + 人设节奏
  mockReply(input = "") {
    const t = String(input);
    const pool = [];
    if (/胖|肥/.test(t)) pool.push("你说谁胖？！……哼，不理你了。");
    if (/笨|傻|蠢/.test(t)) pool.push("你才笨呢，笨蛋主人。");
    if (/可爱|厉害|聪明|棒/.test(t)) pool.push("哼、哼，这种话我才不会高兴呢……只是顺便记住了而已。");
    if (/摸头|摸摸/.test(t)) pool.push("别、别摸头啦！……再摸一下也不是不行。");
    if (/你好|在吗|hi|hello/i.test(t)) pool.push("在的。……才不是特意等你呢。");
    if (/[?？]$/.test(t)) pool.push("这种问题也来问我？……好啦，我只讲一遍。");
    if (/吃|饭|布丁/.test(t)) pool.push("布丁。别的免谈。");
    if (/早上|早安/.test(t)) pool.push("早。……别以为我在等你起床。");
    if (/晚安|睡/.test(t)) pool.push("快去睡，别看手机了。……晚安。");
    if (!pool.length) {
      pool.push(
        "哼，笨蛋主人，我在听。",
        "这种问题也来问我？……好啦，我只讲一遍。",
        "才、才不是特意回你呢，只是顺便而已。",
        "嗯，然后呢？别磨磨蹭蹭的。"
      );
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }
}
