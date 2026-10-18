// 听一下小鲸的声音（不连 QQ，纯本地）
//   node src/say.mjs "哼，笨蛋主人。"
//   node src/say.mjs --open "好啦，我只讲一遍。"
//   node src/say.mjs --sapi "..."      强制用系统语音

import { spawn } from "node:child_process";
import { loadEnv } from "./env.js";

loadEnv(); // 让 .env.local 里的音色生效

const { synthesize, VOICES } = await import("./tts.js");

const args = process.argv.slice(2);
const open = args.includes("--open");
const forceSapi = args.includes("--sapi");
const text = args.filter((a) => !a.startsWith("--")).join(" ").trim();

if (!text) {
  console.log("用法: node src/say.mjs [--open] [--sapi] \"要说的话\"");
  console.log(`可选音色: ${Object.keys(VOICES).join(" / ")}`);
  process.exit(1);
}

const r = await synthesize(text, forceSapi ? { backend: "sapi" } : {});
const sec = r.backend === "edge" ? (r.bytes * 8) / 48000 : r.bytes / (22050 * 2 * 2);
console.log(`✅ [${r.backend}] ${r.ms}ms  ${(r.bytes / 1024).toFixed(1)}KB  ≈${sec.toFixed(1)}s`);
console.log(r.path);

if (open) spawn("cmd", ["/c", "start", "", r.path], { detached: true, stdio: "ignore" }).unref();
