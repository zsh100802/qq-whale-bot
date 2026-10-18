// 极简 .env 加载：读项目根目录的 .env.local（这个文件由你自己填，不要提交、不要给任何人看）
// Node >= 20.12 自带 process.loadEnvFile

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");

export function loadEnv() {
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) return false;
  try {
    process.loadEnvFile(p);
    return true;
  } catch {
    return false;
  }
}
