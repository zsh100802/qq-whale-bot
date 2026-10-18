// 语音合成：优先 Edge 神经语音（msedge-tts），失败自动退回系统 SAPI（Huihui）
// 产出：mp3（edge）或 wav（sapi），路径返回给适配器发给 QQ

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./env.js";

const VOICE_DIR = join(ROOT, "data", "voice");

// 可选音色：Xiaoyi 偏年轻活泼，最贴合“傲娇小鲸”
export const VOICES = {
  xiaoyi: "zh-CN-XiaoyiNeural",
  xiaoxiao: "zh-CN-XiaoxiaoNeural",
  xiaohan: "zh-CN-XiaohanNeural",
  yunxi: "zh-CN-YunxiNeural",
  sapi: "Microsoft Huihui Desktop",
};

// 注意：音色用 WHALE_VOICE_NAME，不要和开关 WHALE_VOICE 撞名
// 不在这里读 env：ESM 的 import 先于 loadEnv() 执行，模块顶层读到的会是旧值


let edgeTts = null;
async function getEdge() {
  if (edgeTts) return edgeTts;
  const mod = await import("msedge-tts");
  edgeTts = mod;
  return edgeTts;
}

// 只保留最近 N 个语音文件，避免磁盘无限膨胀
function cleanOld(dir, keep = 40) {
  try {
    const files = readdirSync(dir)
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function runPowerShell(script) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(err || `SAPI 退出码 ${code}`))));
    p.on("error", reject);
  });
}

async function sapi(text, outWav) {
  const txtPath = outWav + ".txt";
  writeFileSync(txtPath, text, "utf8");
  const q = (s) => s.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}",
    "$s.Rate = 2",
    `$s.SetOutputToWaveFile('${q(outWav)}')`,
    `$s.Speak((Get-Content -Raw -Encoding UTF8 '${q(txtPath)}'))`,
    "$s.Dispose()",
  ].join("; ");
  await runPowerShell(script);
}

/**
 * 合成一句话
 * @param {string} text
 * @param {{voice?:string, rate?:string, pitch?:string, dir?:string, backend?:'edge'|'sapi'}} opts
 * @returns {Promise<{path:string, backend:string, ms:number, bytes:number}>}
 */
export async function synthesize(text, opts = {}) {
  const t0 = Date.now();
  const dir = opts.dir ?? VOICE_DIR;
  mkdirSync(dir, { recursive: true });
  cleanOld(dir);

  const voice = opts.voice ?? process.env.WHALE_VOICE_NAME ?? VOICES.xiaoyi;
  const backend = opts.backend ?? process.env.WHALE_TTS_BACKEND ?? "edge";
  const clipped = String(text).slice(0, 200);

  if (backend === "edge") {
    try {
      const { MsEdgeTTS, OUTPUT_FORMAT } = await getEdge();
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioFilePath } = await tts.toFile(dir, clipped, {
        rate: opts.rate ?? "+8%",
        pitch: opts.pitch ?? "+0Hz",
      });
      tts.close();

      // toFile 固定输出 audio.mp3，必须立刻改成唯一名，否则连续两条会互相覆盖
      const unique = join(dir, `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.mp3`);
      renameSync(audioFilePath, unique);

      const bytes = statSync(unique).size;
      return { path: unique, backend: "edge", ms: Date.now() - t0, bytes };
    } catch (err) {
      // 网络不通或接口变了，静默退回 SAPI
      console.warn(`[tts] Edge 语音失败，退回系统语音：${err.message}`);
    }
  }

  const outWav = join(dir, `v_${Date.now().toString(36)}.wav`);
  await sapi(clipped, outWav);
  try {
    unlinkSync(outWav + ".txt"); // 临时文本文件用完就删
  } catch {
    /* ignore */
  }
  const bytes = statSync(outWav).size;
  return { path: outWav, backend: "sapi", ms: Date.now() - t0, bytes };
}

export function voiceDir() {
  return VOICE_DIR;
}
