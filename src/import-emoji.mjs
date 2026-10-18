// 表情包导入脚本：扫描 QQ 小号的图片缓存，把真实图片文件拷进图库
// 用法：
//   node src/import-emoji.mjs <QQ号> [目标情绪文件夹]
// 说明：
//   - 会扫描 QQ 数据目录里的所有图片（排除头像/在线状态图标），按修改时间排序
//   - 交互式让你给每张图选情绪分类（或跳过），拷进 assets/emoji/<情绪>/
//   - 若带第二参数（情绪名），则跳过交互，全部归到该情绪下
//
// 建议流程：先用手机给小号发一批表情包 → 运行本脚本 → 逐个分类。

import { readdirSync, statSync, readFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { createInterface } from "node:readline";

const QQ = process.argv[2];
const FIXED_TAG = process.argv[3] ?? "";

if (!QQ) {
  console.log("用法：node src/import-emoji.mjs <QQ号> [情绪名]");
  console.log("  情绪名：开心 生气 傲娇 委屈 卖萌 无语 得意 摸鱼 晚安 早安");
  process.exit(1);
}

const QQ_ROOT = join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Documents",
  "Tencent Files",
  QQ,
  "nt_qq",
  "nt_data"
);

const TAGS = ["开心", "生气", "傲娇", "委屈", "卖萌", "无语", "得意", "摸鱼", "晚安", "早安"];
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

// 排除目录（头像、在线状态图标、系统表情都不是我们要的）
const EXCLUDE_DIRS = ["avatar", "OnlineStatus", "BaseEmojiSyastems", "emoji-related"];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.includes(e.name)) continue;
      walk(p, out);
    } else if (e.isFile() && IMG_EXT.has(extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

const images = walk(QQ_ROOT)
  .map((p) => ({ p, size: statSync(p).size, mtime: statSync(p).mtimeMs }))
  .filter((x) => x.size > 1000) // 过滤掉极小/占位图
  .sort((a, b) => b.mtime - a.mtime);

if (!images.length) {
  console.log("没扫到图片。可能小号还没收发过表情包，或 QQ 数据目录路径不对。");
  console.log(`扫描根目录：${QQ_ROOT}`);
  process.exit(0);
}

console.log(`共扫到 ${images.length} 张候选图片（按时间倒序）：\n`);
images.slice(0, 40).forEach((x, i) => {
  console.log(`[${i}] ${(x.size / 1024).toFixed(0)}KB  ${basename(x.p)}`);
});
console.log("");

// 固定情绪模式：全部直接拷
if (FIXED_TAG) {
  if (!TAGS.includes(FIXED_TAG)) {
    console.log(`未知情绪「${FIXED_TAG}」，可用：${TAGS.join("、")}`);
    process.exit(1);
  }
  const dstDir = join(process.cwd(), "assets", "emoji", FIXED_TAG);
  mkdirSync(dstDir, { recursive: true });
  let n = 0;
  for (const img of images) {
    const dst = join(dstDir, `${Date.now()}-${n++}${extname(img.p).toLowerCase()}`);
    copyFileSync(img.p, dst);
  }
  console.log(`已把 ${n} 张图拷进「${FIXED_TAG}」`);
  process.exit(0);
}

// 交互模式：逐张选分类
const rl = createInterface({ input: process.stdin, output: process.stdout });
let idx = 0;
let copied = 0;

function ask() {
  if (idx >= images.length) {
    console.log(`\n完成，共导入 ${copied} 张。`);
    rl.close();
    return;
  }
  const img = images[idx];
  const name = basename(img.p);
  console.log(`\n[${idx + 1}/${images.length}] ${(img.size / 1024).toFixed(0)}KB  ${name}`);
  console.log(`  情绪：0 开心 1 生气 2 傲娇 3 委屈 4 卖萌 5 无语 6 得意 7 摸鱼 8 晚安 9 早安  s 跳过  q 结束`);
  rl.question("  选：", (ans) => {
    const a = ans.trim().toLowerCase();
    if (a === "q") {
      console.log(`\n结束，共导入 ${copied} 张。`);
      rl.close();
      return;
    }
    if (a === "s" || a === "") {
      idx++;
      ask();
      return;
    }
    const n = Number(a);
    if (Number.isInteger(n) && n >= 0 && n < TAGS.length) {
      const tag = TAGS[n];
      const dstDir = join(process.cwd(), "assets", "emoji", tag);
      mkdirSync(dstDir, { recursive: true });
      const dst = join(dstDir, `${Date.now()}-${copied}${extname(img.p).toLowerCase()}`);
      copyFileSync(img.p, dst);
      copied++;
      console.log(`  ✅ 已归入「${tag}」`);
    } else {
      console.log("  ⚠️ 无效输入，跳过");
    }
    idx++;
    ask();
  });
}

ask();
