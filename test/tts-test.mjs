// 语音链路自测：合成两句，报告后端、耗时、体积、预估时长
//   node test/tts-test.mjs
//   node test/tts-test.mjs --sapi   强制走系统语音

import { statSync } from "node:fs";
import { synthesize, VOICES } from "../src/tts.js";

const forceSapi = process.argv.includes("--sapi");

const lines = [
  "哼，笨蛋，这种问题也来问我？",
  "好啦，我只讲一遍：十七乘二十三等于三百九十一。",
];

for (const line of lines) {
  try {
    const r = await synthesize(line, forceSapi ? { backend: "sapi" } : {});
    const sec = r.backend === "edge" ? (r.bytes * 8) / 48000 : r.bytes / (22050 * 2 * 2);
    console.log(
      `✅ [${r.backend}] ${r.ms}ms  ${(r.bytes / 1024).toFixed(1)}KB  ≈${sec.toFixed(1)}s  ${r.path}`
    );
  } catch (err) {
    console.log(`❌ 合成失败：${err.message}`);
    process.exitCode = 1;
  }
}
