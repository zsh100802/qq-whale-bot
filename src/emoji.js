// 表情包发送模块：根据回复情绪，从本地图库挑一张图片发出去
// 图库结构：assets/emoji/<情绪>/xxx.png|jpg|gif|jpeg|webp
// 情绪名由模型在回复末尾输出 [[emoji:开心]] 隐藏标记指定，程序剥掉标记后随机选图。
// 若无匹配图库或没标记，则不发表情，退回纯文字（绝不影响主回复）。

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMOJI_ROOT = join(__dirname, "..", "assets", "emoji");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

// 剥掉 [[emoji:xxx]] 标记，返回 { text, tag }
export function extractEmojiTag(text) {
  const marker = /\[\[\s*emoji\s*:\s*([^\]]{1,12})\s*\]\]/i;
  const m = String(text ?? "").match(marker);
  if (!m) return { text, tag: null };
  const tag = m[1].trim();
  const rest = String(text).replace(marker, "").trim();
  return { text: rest, tag };
}

// 列出某情绪目录下所有可用图片
function listImages(tag) {
  const dir = join(EMOJI_ROOT, tag);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// 单图权重配置：assets/emoji/weights.json
// 格式：{ "情绪名": { "图片文件名": 比重 } }，比重 0~1，剩余比重由其他图均分。
// 文件不存在或没写对应情绪时，退回纯随机均分。
function loadWeights(tag) {
  const wf = join(EMOJI_ROOT, "weights.json");
  try {
    const cfg = JSON.parse(readFileSync(wf, "utf8"));
    return cfg?.[tag] ?? null;
  } catch {
    return null;
  }
}

// 从指定情绪随机挑一张图片的绝对路径；没有则返回 null
// 支持单图加权：weights.json 里配了比重的图优先按比重命中
export function pickEmoji(tag) {
  if (!tag) return null;
  const imgs = listImages(tag);
  if (!imgs.length) return null;

  const weights = loadWeights(tag);
  if (weights) {
    // 只保留图库里真实存在的加权图
    const valid = Object.entries(weights).filter(([name]) =>
      imgs.some((p) => basename(p) === name)
    );
    const totalW = valid.reduce((s, [, w]) => s + Number(w) || 0, 0);
    if (valid.length && totalW > 0 && totalW < 1) {
      const r = Math.random();
      if (r < totalW) {
        // 命中加权区：按比重在加权图内分配
        let acc = 0;
        for (const [name, w] of valid) {
          acc += Number(w) || 0;
          if (r < acc) {
            return imgs.find((p) => basename(p) === name);
          }
        }
      }
      // 未命中加权区（概率 1-totalW）：从其余图均分
      const rest = imgs.filter((p) => !valid.some(([name]) => basename(p) === name));
      if (rest.length) return rest[Math.floor(Math.random() * rest.length)];
    }
    // 权重配置无效（≥1 或全 0）时落到下面的均分逻辑
  }

  return imgs[Math.floor(Math.random() * imgs.length)];
}

// 把所有可用情绪分类列出来（给自检/日志用）
export function availableEmojiTags() {
  try {
    return readdirSync(EMOJI_ROOT)
      .filter((d) => existsSync(join(EMOJI_ROOT, d)) && listImages(d).length > 0)
      .map((d) => `${d}(${listImages(d).length})`);
  } catch {
    return [];
  }
}

// 图片文件 → OneBot image 段。优先 base64（跨端通用），失败退回 file:/// 本地路径。
export function imageSegment(filePath) {
  try {
    const buf = readFileSync(filePath);
    const mime = mimeOf(filePath);
    return { type: "image", data: { file: `base64://${buf.toString("base64")}` } };
  } catch {
    return { type: "image", data: { file: fileUri(filePath) } };
  }
}

function fileUri(p) {
  return "file:///" + p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function mimeOf(p) {
  switch (extname(p).toLowerCase()) {
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    default: return "image/png";
  }
}
