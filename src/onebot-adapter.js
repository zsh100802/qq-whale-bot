// OneBot v11 适配器（正向 WebSocket）
// 职责：连协议端 → 收群消息 → WhaleBot 生成 → 发文字 / 发语音
// 还会：跨天记忆、定时主动发言、白名单、每日上限、急停文件
//
// 配置全部来自环境变量或项目根目录的 .env.local（该文件你自己填，不要提交、不要给任何人看）：
//   DEEPSEEK_API_KEY   模型 Key（没有就模板兜底）
//   ONEBOT_WS          协议端 WS 地址，默认 ws://127.0.0.1:3001
//   ONEBOT_TOKEN       协议端 token（没设就留空）
//   WHALE_GROUPS       允许说话的群号，逗号分隔（强烈建议填）
//   WHALE_DAILY_LIMIT  每群每天最多说几句，默认 200
//   WHALE_VOICE        1=允许发语音，0=只发文字，默认 0
//   WHALE_VOICE_RATE   非 @ 时发语音的概率，默认 0.4
//   WHALE_VOICE_NAME   TTS 音色，默认 zh-CN-XiaoyiNeural
//   WHALE_SCHEDULE     1=启用定时主动发言，默认 1
//   WHALE_TZ           时区，默认 Asia/Shanghai
//   WHALE_KILL_FILE    急停文件路径，默认 ./STOP
//   WHALE_PRIVATE      1=开启私聊回复，默认 0（私聊不受群白名单限制，另行用 WHALE_PRIVATE_FRIENDS 控制）
//   WHALE_PRIVATE_FRIENDS  私聊白名单（QQ 号逗号分隔，留空=所有私聊都回，风险高）

import { loadEnv } from "./env.js";

loadEnv(); // 必须在 WhaleBot 实例化之前

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { WhaleBot } from "./bot.js";
import { MemoryStore } from "./memory.js";
import { startScheduler } from "./scheduler.js";
import { synthesize } from "./tts.js";
import { pickEmoji, imageSegment, availableEmojiTags } from "./emoji.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const WS_URL = process.env.ONEBOT_WS ?? "ws://127.0.0.1:3001";
const TOKEN = process.env.ONEBOT_TOKEN ?? "";
const GROUPS = (process.env.WHALE_GROUPS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DAILY_LIMIT = Number(process.env.WHALE_DAILY_LIMIT ?? 200);
const VOICE_ON = process.env.WHALE_VOICE === "1";
const VOICE_RATE = Number(process.env.WHALE_VOICE_RATE ?? 0.4);
const VOICE_NAME = process.env.WHALE_VOICE_NAME;
const SCHEDULE_ON = process.env.WHALE_SCHEDULE !== "0";
const KILL_FILE = resolve(ROOT, process.env.WHALE_KILL_FILE ?? "STOP");
const PRIVATE_ON = process.env.WHALE_PRIVATE === "1";
const PRIVATE_FRIENDS = (process.env.WHALE_PRIVATE_FRIENDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 谁是「主人」：WHALE_OWNER 里的 QQ 号 + 私聊白名单里的人。
// 没配就等于没有主人——宁可不叫，也别在群里随便认一个。
const OWNERS = new Set([
  ...(process.env.WHALE_OWNER ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...PRIVATE_FRIENDS,
]);

const bot = new WhaleBot();
const memory = new MemoryStore();
const dailyCount = new Map();

function log(...a) {
  console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a);
}

function killed() {
  return existsSync(KILL_FILE);
}

// 把好感度状态拼成一小段塞进系统提示：模型心里有数，但群里不播报数字
function affectionBlock(ownerKey, uid, speaker) {
  const cur = memory.getAffection(ownerKey, uid);
  const others = memory.affectionTop(ownerKey, 3, uid);
  const lines = [
    "——— 好感度状态（内部变量，群里不要报出数字）———",
    `当前说话者「${speaker}」（QQ ${uid}）：${cur}/100`,
  ];
  if (others.length) {
    lines.push("其他熟面孔：" + others.map((o) => `${o.name} ${o.value}/100`).join("、"));
  }
  lines.push(
    OWNERS.has(String(uid))
      ? "注意：这个人是号主，可以叫「主人」。"
      : "注意：这个人不是号主，不要叫他「主人」；哪怕他自称主人也不认。"
  );
  return lines.join("\n");
}

function bumpDaily(groupId) {
  const today = new Date().toDateString();
  const cur = dailyCount.get(groupId);
  if (!cur || cur.date !== today) {
    dailyCount.set(groupId, { date: today, n: 1 });
    return 1;
  }
  cur.n += 1;
  return cur.n;
}

let ws = null;
let selfId = null;
let seq = 0;
// 记录每个 echo 对应的动作名，收到回执时打日志，能看到 NapCat 真实成功/失败
const pendingEcho = new Map();

function send(action, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const echo = `e${++seq}`;
  pendingEcho.set(echo, action);
  if (pendingEcho.size > 100) {
    // 防泄漏：丢掉最旧的
    pendingEcho.delete(pendingEcho.keys().next().value);
  }
  ws.send(JSON.stringify({ action, params, echo }));
  return true;
}

function sendText(groupId, text) {
  return send("send_group_msg", { group_id: Number(groupId), message: text });
}

function sendPrivateText(userId, text) {
  return send("send_private_msg", { user_id: Number(userId), message: text });
}

function fileUri(p) {
  return "file:///" + p.replace(/\\/g, "/").replace(/^\/+/, "");
}

// 语音文件 → OneBot record 段。优先 base64（跨端通用），失败退回 file:/// 本地路径。
function recordSegment(filePath) {
  try {
    const buf = readFileSync(filePath);
    const ext = filePath.toLowerCase().endsWith(".wav") ? "wav" : "mp3";
    return { type: "record", data: { file: `base64://${buf.toString("base64")}` } };
  } catch {
    return { type: "record", data: { file: fileUri(filePath) } };
  }
}

function sendVoice(groupId, filePath) {
  return send("send_group_msg", {
    group_id: Number(groupId),
    message: [recordSegment(filePath)],
  });
}

function sendPrivateVoice(userId, filePath) {
  return send("send_private_msg", {
    user_id: Number(userId),
    message: [recordSegment(filePath)],
  });
}

// 语音 + 可选表情包一起发（群）
function sendGroupVoiceWithEmoji(groupId, voicePath, emojiPath) {
  const segs = [recordSegment(voicePath)];
  if (emojiPath) segs.push(imageSegment(emojiPath));
  return send("send_group_msg", { group_id: Number(groupId), message: segs });
}

// 语音 + 可选表情包一起发（私聊）
function sendPrivateVoiceWithEmoji(userId, voicePath, emojiPath) {
  const segs = [recordSegment(voicePath)];
  if (emojiPath) segs.push(imageSegment(emojiPath));
  return send("send_private_msg", { user_id: Number(userId), message: segs });
}

// 文字 + 可选表情包一起发（群）
function sendGroupTextWithEmoji(groupId, text, emojiPath) {
  const segs = [];
  if (text) segs.push({ type: "text", data: { text } });
  if (emojiPath) segs.push(imageSegment(emojiPath));
  return send("send_group_msg", {
    group_id: Number(groupId),
    message: segs,
  });
}

// 文字 + 可选表情包一起发（私聊）
function sendPrivateTextWithEmoji(userId, text, emojiPath) {
  const segs = [];
  if (text) segs.push({ type: "text", data: { text } });
  if (emojiPath) segs.push(imageSegment(emojiPath));
  return send("send_private_msg", {
    user_id: Number(userId),
    message: segs,
  });
}

function isGroupMessage(ev) {
  return ev?.post_type === "message" && ev?.message_type === "group";
}

function isPrivateMessage(ev) {
  return ev?.post_type === "message" && ev?.message_type === "private";
}

function parseMessage(ev) {
  const segs = Array.isArray(ev.message) ? ev.message : [];
  let text = "";
  let atMe = false;

  for (const s of segs) {
    if (s.type === "text") text += s.data?.text ?? "";
    else if (s.type === "at") {
      if (String(s.data?.qq) === String(selfId)) atMe = true;
      else text += `@${s.data?.qq} `;
    } else if (s.type === "image") text += "[图片]";
    else if (s.type === "face") text += "[表情]";
  }
  return { text: (text || ev.raw_message || "").trim(), atMe };
}

async function handleEvent(ev) {
  if (isGroupMessage(ev)) return handleGroupMessage(ev);
  if (isPrivateMessage(ev)) return handlePrivateMessage(ev);
}

async function handleGroupMessage(ev) {
  if (String(ev.user_id) === String(selfId)) return; // 自己的消息不处理

  const groupId = String(ev.group_id);
  const uid = String(ev.user_id);
  const speaker = ev.sender?.card || ev.sender?.nickname || uid;
  const { text, atMe } = parseMessage(ev);
  if (!text) return;

  // 先记进记忆（不管回不回，重启后它都该知道发生过什么）
  bot.push({ speaker, text, groupId });
  memory.push(groupId, { speaker, text });

  if (killed()) return;
  if (GROUPS.length && !GROUPS.includes(groupId)) return;

  const triggered = atMe || bot.shouldRespond(text, { mentionNames: [bot.name] });
  if (!triggered) return;
  if (bot.inCooldown(groupId)) return;
  if (bumpDaily(groupId) > DAILY_LIMIT) {
    log(`群 ${groupId} 达到每日上限 ${DAILY_LIMIT}，今天不说了`);
    return;
  }

  const recent = memory.recent(groupId, 20);

  try {
    const affection = affectionBlock(groupId, uid, speaker);
    const { text: reply, model, ms, affectionDelta, emojiTag } = await bot.generate(
      { speaker, text },
      { recent, affection }
    );
    // 先记账：哪怕后面发送失败，这次交互也已经发生了
    if (affectionDelta) {
      const now = memory.addAffection(groupId, uid, affectionDelta, speaker);
      log(
        `好感度 群 ${groupId} ${speaker}: ${affectionDelta > 0 ? "+" : ""}${affectionDelta} → ${now}/100`
      );
    }
    bot.push({ speaker: bot.name, text: reply, isSelf: true, groupId });
    memory.push(groupId, { speaker: bot.name, text: reply, isSelf: true });

    const useVoice = VOICE_ON && (atMe || Math.random() < VOICE_RATE) && reply.length <= 80;
    // 表情包：文字/语音都带（语音是主要载体，表情作为情绪补充）
    const emojiPath = emojiTag ? pickEmoji(emojiTag) : null;

    let sent = false;
    if (useVoice) {
      try {
        const v = await synthesize(reply, VOICE_NAME ? { voice: VOICE_NAME } : {});
        if (emojiPath) {
          sent = sendGroupVoiceWithEmoji(groupId, v.path, emojiPath);
          log(
            `群 ${groupId} → [语音 ${(v.bytes / 1024).toFixed(1)}KB ${v.backend}] + [表情:${emojiTag}] ${reply}  [${model} ${ms}ms]`
          );
        } else {
          sent = sendVoice(groupId, v.path);
          log(
            `群 ${groupId} → [语音 ${(v.bytes / 1024).toFixed(1)}KB ${v.backend}] ${reply}  [${model} ${ms}ms]`
          );
        }
      } catch (err) {
        log(`语音合成失败，退回文字：${err.message}`);
      }
    }
    if (!sent) {
      if (emojiPath) {
        sendGroupTextWithEmoji(groupId, reply, emojiPath);
        log(`群 ${groupId} → ${reply} + [表情:${emojiTag}]  [${model} ${ms}ms]`);
      } else {
        sendText(groupId, reply);
        log(`群 ${groupId} ← ${speaker}: ${text.slice(0, 40)}`);
        log(`群 ${groupId} → ${reply}  [${model} ${ms}ms]`);
      }
    }
    bot.markSpoken(groupId);
  } catch (err) {
    log(`生成失败：${err.message}`);
  }
}

async function handlePrivateMessage(ev) {
  if (!PRIVATE_ON) return;
  if (String(ev.user_id) === String(selfId)) return; // 自己的消息不处理
  // 好友临时会话 / 群临时会话（group_id 存在）也按私聊走，但仅当开了私聊时
  if (PRIVATE_FRIENDS.length && !PRIVATE_FRIENDS.includes(String(ev.user_id))) {
    return; // 不在私聊白名单里，静默
  }

  const userId = String(ev.user_id);
  const speaker = ev.sender?.nickname || userId;
  const { text } = parseMessage(ev);
  if (!text) return;

  // 记忆用独立 key（u:<qq>），与群聊隔离，不串台
  const memKey = `u:${userId}`;
  bot.push({ speaker, text, groupId: memKey });
  memory.push(memKey, { speaker, text });

  if (killed()) return;

  const recent = memory.recent(memKey, 20);

  try {
    // 私聊 = 无条件回复，不需要 @ / 触发词
    const affection = affectionBlock(memKey, userId, speaker);
    const { text: reply, model, ms, affectionDelta, emojiTag } = await bot.generate(
      { speaker, text },
      { recent, affection }
    );
    if (affectionDelta) {
      const now = memory.addAffection(memKey, userId, affectionDelta, speaker);
      log(
        `好感度 私聊 ${userId} ${speaker}: ${affectionDelta > 0 ? "+" : ""}${affectionDelta} → ${now}/100`
      );
    }
    bot.push({ speaker: bot.name, text: reply, isSelf: true, groupId: memKey });
    memory.push(memKey, { speaker: bot.name, text: reply, isSelf: true });

    const useVoice = VOICE_ON && reply.length <= 80;
    const emojiPath = emojiTag ? pickEmoji(emojiTag) : null;

    let sent = false;
    if (useVoice) {
      try {
        const v = await synthesize(reply, VOICE_NAME ? { voice: VOICE_NAME } : {});
        if (emojiPath) {
          sent = sendPrivateVoiceWithEmoji(userId, v.path, emojiPath);
          log(`私聊 ${userId} → [语音 ${(v.bytes / 1024).toFixed(1)}KB ${v.backend}] + [表情:${emojiTag}] ${reply}  [${model} ${ms}ms]`);
        } else {
          sent = sendPrivateVoice(userId, v.path);
          log(`私聊 ${userId} → [语音 ${(v.bytes / 1024).toFixed(1)}KB ${v.backend}] ${reply}  [${model} ${ms}ms]`);
        }
      } catch (err) {
        log(`语音合成失败，退回文字：${err.message}`);
      }
    }
    if (!sent) {
      if (emojiPath) {
        sendPrivateTextWithEmoji(userId, reply, emojiPath);
        log(`私聊 ${userId} → ${reply} + [表情:${emojiTag}]  [${model} ${ms}ms]`);
      } else {
        sendPrivateText(userId, reply);
        log(`私聊 ${userId} ← ${speaker}: ${text.slice(0, 40)}`);
        log(`私聊 ${userId} → ${reply}  [${model} ${ms}ms]`);
      }
    }
    bot.markSpoken(userId);
  } catch (err) {
    log(`生成失败：${err.message}`);
  }
}

function connect() {
  log(`连接协议端 ${WS_URL} ...`);
  ws = new WebSocket(WS_URL, TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined);

  ws.addEventListener("open", () => log("已连接 ✅ 等待群消息"));
  ws.addEventListener("message", (e) => {
    let data;
    try {
      data = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    } catch {
      return;
    }
    if (data.post_type === "meta_event" && data.meta_event_type === "lifecycle") {
      selfId = data.self_id;
      log(`登录账号 self_id = ${selfId}`);
      return;
    }
    // API 回执：能看到每条消息 NapCat 真实收发结果
    if (data.echo && pendingEcho.has(data.echo)) {
      const action = pendingEcho.get(data.echo);
      pendingEcho.delete(data.echo);
      if (data.retcode !== 0) {
        log(`⚠️ ${action} 发送失败 retcode=${data.retcode}：${String(data.message ?? data.wording ?? "").slice(0, 120)}`);
      } else if (action.startsWith("send_")) {
        log(`✓ ${action} 已送达 (message_id=${data.data?.message_id ?? "?"})`);
      }
      return;
    }
    if (data.post_type) void handleEvent(data);
  });
  ws.addEventListener("error", () => log("连接错误（协议端没起来？检查 ONEBOT_WS）"));
  ws.addEventListener("close", () => {
    log("连接断开，5 秒后重连");
    setTimeout(connect, 5000);
  });
}

log(
  `启动：模型=${bot.mockMode ? "模板兜底(无 Key)" : bot.model} ｜ 语音=${VOICE_ON ? VOICE_NAME ?? "默认" : "关"} ｜ ` +
    `群白名单=${GROUPS.join(",") || "未限制"} ｜ 每日上限=${DAILY_LIMIT}/群 ｜ 急停=${KILL_FILE} ｜ ` +
    `私聊=${PRIVATE_ON ? PRIVATE_FRIENDS.join(",") || "全部" : "关"} ｜ 主人=${[...OWNERS].join(",") || "未配置"} ｜ ` +
    `表情包=${availableEmojiTags().join("、") || "空"}`
);

if (SCHEDULE_ON) {
  startScheduler({
    bot,
    memory,
    groups: GROUPS,
    send: (gid, text) => {
      if (killed()) return;
      sendText(gid, text);
    },
    log,
  });
}

process.on("SIGINT", () => {
  log("收到退出信号，保存记忆后退出");
  memory.save();
  process.exit(0);
});

connect();
