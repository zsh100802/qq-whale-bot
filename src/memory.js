// 跨天记忆：把群聊记录落到 data/memory.json，重启不丢
// 设计目标只有一个：让「它还记得昨天」这件事成立。不做花哨的向量库。

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT } from "./env.js";

const MAX_PER_GROUP = 200;
const MAX_GROUPS = 20;

// 好感度：-100 ~ +100，初始 30。每个群 / 每个私聊里，对每个 QQ 号单独记一份。
const AFF_MIN = -100;
const AFF_MAX = 100;
const AFF_DEFAULT = 30;
const AFF_MAX_USERS = 200; // 每个群最多记这么多人，防止文件无限膨胀

function clampAff(v) {
  const n = Math.round(Number(v) || 0);
  return Math.max(AFF_MIN, Math.min(AFF_MAX, n));
}

export class MemoryStore {
  constructor(file = join(ROOT, "data", "memory.json")) {
    this.file = file;
    this.data = { version: 2, groups: {}, schedule: {}, affection: {} };
    this.dirty = false;
    this.timer = null;
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object") {
        this.data = {
          version: 2,
          groups: raw.groups ?? {},
          schedule: raw.schedule ?? {},
          // 旧文件没有 affection 字段 → 空对象，老数据照常读
          affection: raw.affection ?? {},
        };
      }
    } catch {
      // 文件坏了就当空的，不阻塞启动
      this.data = { version: 2, groups: {}, schedule: {}, affection: {} };
    }
  }

  push(groupId, entry) {
    const g = String(groupId);
    const list = (this.data.groups[g] ??= []);
    list.push({
      speaker: String(entry.speaker ?? "某人").slice(0, 16),
      text: String(entry.text ?? "").slice(0, 500),
      isSelf: !!entry.isSelf,
      ts: entry.ts ?? Date.now(),
    });
    if (list.length > MAX_PER_GROUP) list.splice(0, list.length - MAX_PER_GROUP);

    // 群数量上限，丢掉最久没说话的
    const keys = Object.keys(this.data.groups);
    if (keys.length > MAX_GROUPS) {
      const oldest = keys
        .sort((a, b) => (this.data.groups[a].at(-1)?.ts ?? 0) - (this.data.groups[b].at(-1)?.ts ?? 0))
        .slice(0, keys.length - MAX_GROUPS);
      for (const k of oldest) delete this.data.groups[k];
    }

    this.scheduleSave();
  }

  recent(groupId, n = 20) {
    const list = this.data.groups[String(groupId)] ?? [];
    return list.slice(-n);
  }

  groups() {
    return Object.keys(this.data.groups);
  }

  // 记录某类定时消息今天已经发过，重启也不会重复
  getScheduleDone(kind) {
    return this.data.schedule?.[kind] ?? "";
  }

  setScheduleDone(kind, dateKey) {
    this.data.schedule ??= {};
    this.data.schedule[kind] = dateKey;
    this.scheduleSave();
  }

  // ---- 好感度 ----
  // ownerKey：群号，或私聊的 "u:<qq>"；uid：说话人的 QQ 号
  getAffection(ownerKey, uid) {
    const rec = this.data.affection?.[String(ownerKey)]?.[String(uid)];
    return rec ? clampAff(rec.value) : AFF_DEFAULT;
  }

  addAffection(ownerKey, uid, delta, name = "") {
    const d = Math.round(Number(delta));
    if (!Number.isFinite(d) || d === 0) return this.getAffection(ownerKey, uid);

    const owner = String(ownerKey);
    const id = String(uid);
    const bucket = (this.data.affection[owner] ??= {});
    const rec = bucket[id] ?? { value: AFF_DEFAULT, name: "", updatedAt: 0 };

    // 单次最多 ±10，防止一句话就把好感度拉爆
    rec.value = clampAff(rec.value + Math.max(-10, Math.min(10, d)));
    if (name) rec.name = String(name).slice(0, 16);
    rec.updatedAt = Date.now();
    bucket[id] = rec;

    // 人数上限：丢掉最久没更新的
    const keys = Object.keys(bucket);
    if (keys.length > AFF_MAX_USERS) {
      keys
        .sort((a, b) => (bucket[a].updatedAt ?? 0) - (bucket[b].updatedAt ?? 0))
        .slice(0, keys.length - AFF_MAX_USERS)
        .forEach((k) => delete bucket[k]);
    }

    this.scheduleSave();
    return rec.value;
  }

  // 群里好感度最高的几个人，给模型一点"跟谁熟"的参照
  affectionTop(ownerKey, n = 3, excludeUid = "") {
    const bucket = this.data.affection?.[String(ownerKey)] ?? {};
    return Object.entries(bucket)
      .filter(([uid]) => String(uid) !== String(excludeUid))
      .map(([uid, rec]) => ({ uid, name: rec.name || uid, value: clampAff(rec.value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, n);
  }

  scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.save();
    }, 2000);
    this.timer.unref?.();
  }

  save() {
    try {
      mkdirSync(join(ROOT, "data"), { recursive: true });
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.file); // 原子替换，写一半断电也不会坏档
      this.dirty = false;
    } catch (err) {
      console.error(`[memory] 保存失败：${err.message}`);
    }
  }
}
