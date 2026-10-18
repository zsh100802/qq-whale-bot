# 🐋 深小鲸 · QQ 机器人 v0.2

一个跑在 QQ 群里的傲娇鲸鱼机器人。文字、语音、跨天记忆、定时主动开口。

| 能力 | 状态 |
|---|---|
| 群里被 @ 或叫名字才回话 | ✅ 已实现 |
| 私聊回复（可选好友白名单） | ✅ 已实现并验证 |
| 发语音（Edge 神经音色 / 系统音色兜底） | ✅ 已实现并验证 |
| 按情绪发表情包（本地图库） | ✅ 已实现 |
| 跨天记忆（重启不丢上下文） | ✅ 已实现并验证 |
| 定时主动发言（早安 08:30 / 晚安 23:00） | ✅ 已实现并验证 |
| 群白名单 / 每日上限 / 急停文件 | ✅ 已实现 |
| 发 QQ 空间动态 | ❌ 未做（最脆、风险最高） |
| 操控安卓手机 / 刷 B 站 | ❌ 未做（需要模拟器 + ADB，另说） |

> 语音、记忆、调度都已用**假协议端离线跑通**，不依赖真实 QQ。
> 真协议端要你自己部署——登录态和密码永远留在你本机，这段代码不碰。

## 目录

```
qq-whale-bot/
├── persona/persona.md          人设提示词（要改性格只改这里）
├── config/schedule.json        定时发言的时刻表
├── src/bot.js                  大脑：触发判定 / 上下文 / 调模型 / 清洗
├── src/onebot-adapter.js       OneBot v11 适配器（文字 + 语音 + 记忆 + 调度）
├── src/tts.js                  语音合成（Edge 优先，SAPI 兜底）
├── src/emoji.js                表情包：按情绪从本地图库选图
├── src/import-emoji.mjs        从 QQ 缓存导入表情包（交互式分类）
├── src/memory.js               跨天记忆，落盘到 data/memory.json
├── src/scheduler.js            定时主动发言
├── src/say.mjs                 本地听一耳朵（不连 QQ）
├── src/selfcheck.mjs           环境自检（哪一环没接上一眼看出）
├── src/cli.js                  本地群聊模拟器
├── test/                       离线自测（假协议端 / 记忆 / 调度 / TTS）
├── 启动.bat / 急停.bat / 恢复.bat / 检查环境.bat
└── .env.example                配置模板 → 复制成 .env.local 再填
```

## 你要做的事（6 步）

### ① 准备一个 QQ 小号

**不建议用主号。** 个人号走非官方协议，被判定为机器行为就可能封，不看动机。

### ② 部署协议端

二选一，都在你自己的电脑上跑：

- [NapCatQQ](https://github.com/NapNeko/NapCatQQ)（Windows 最省事）
- [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core)

> 都是第三方开源项目，请自行评估、锁定版本。装完用**小号扫码登录**。

### ③ 打开 OneBot v11 正向 WebSocket

在协议端设置里开「WebSocket 服务」，默认地址通常是 `ws://127.0.0.1:3001`。
记下**端口**；如果设了 access token，也记下。

### ④ 填配置

复制 `.env.example` 为 `.env.local`（这个文件已被 `.gitignore` 排除，**别提交、别截图、别发人**）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 你的模型 Key。没有也能跑，但只会用模板话术 |
| `ONEBOT_WS` | 是 | 协议端地址，如 `ws://127.0.0.1:3001` |
| `ONEBOT_TOKEN` | 否 | 协议端设了 token 才填 |
| `WHALE_GROUPS` | **强烈建议** | 只在这个群说话，逗号分隔 |
| `WHALE_DAILY_LIMIT` | 否 | 每群每天最多说几句，默认 120 |
| `WHALE_VOICE` | 否 | `0` 只发文字，`1` 发语音。**建议先跑通文字再开** |
| `WHALE_VOICE_NAME` | 否 | 默认 `zh-CN-XiaoyiNeural`（年轻活泼） |
| `WHALE_SCHEDULE` | 否 | `1` 开定时主动发言，`0` 关 |
| `WHALE_PRIVATE` | 否 | `1` 开私聊回复，`0` 关（默认关） |
| `WHALE_PRIVATE_FRIENDS` | 否 | 私聊白名单，QQ 号逗号分隔；留空=所有私聊都回（风险高） |

### ⑤ 双击 `检查环境.bat`（强烈建议）

它会逐项报：Node 版本、`.env.local`、Key 是否设置（只报长度）、协议端**能不能连上**、
语音能不能合成、群白名单填了没、定时配置在不在。全绿再往下走。

### ⑥ 双击 `启动.bat`

窗口里出现 `已连接 ✅ 等待群消息` 就成功了。**关掉窗口 = 机器人下线。**

### ⑦ 在群里 @ 它，或直接叫「小鲸」

## 先听一耳朵

不用连 QQ，直接合成：

```powershell
node src/say.mjs --open "哼，笨蛋主人，这种问题也来问我？"
```

会生成 mp3 并自动打开播放。觉得音色不对就改 `.env.local` 里的 `WHALE_VOICE_NAME`：

| 音色 | 感觉 |
|---|---|
| `zh-CN-XiaoyiNeural` | 年轻、活泼（默认，最贴人设） |
| `zh-CN-XiaoxiaoNeural` | 温和、自然 |
| `zh-CN-XiaohanNeural` | 偏低、冷静 |
| `zh-CN-YunxiNeural` | 男声 |

> 没网或接口挂了会自动退回系统 Huihui 音色（机械一些，但能用）。

## 记忆与主动发言

- **记忆**：每个群最近 200 条存进 `data/memory.json`，重启后接着聊，不会「失忆」。
- **主动发言**：`config/schedule.json` 里改时刻，默认早安 `08:30`、晚安 `23:00`。
  同一天同一类只发一次，重启也不会重复。
- 它主动说话时没有触发消息，走的是另一套提示词（更短、更像随口一句）。

## 急停与恢复

| 操作 | 效果 |
|---|---|
| 双击 `急停.bat`（或手动建一个 `STOP` 空文件） | 立刻只记录、不说话 |
| 双击 `恢复.bat`（或删掉 `STOP`） | 恢复说话 |

**不用重启进程。** 出事的时候先点它。

## 自测（不碰真实 QQ）

```powershell
npm test
```

跑两组离线测试：

1. **记忆 + 调度**：落盘重载、到点只发一次、重启不重复、多群上下文不串台
2. **端到端**：本地假协议端 → 适配器 → 生成 → TTS → `send_group_msg(record)`

预期最后一行：

```
✅ 端到端链路验证通过：事件 → 触发 → 生成 → TTS → send_group_msg(record)
```

再单独测语音：

```powershell
node test/tts-test.mjs          # Edge 神经音色
node test/tts-test.mjs --sapi   # 系统音色兜底
```

## 本地模拟群聊（不开 QQ 也能调人设）

```powershell
node src/cli.js                                  # 交互
node src/cli.js --script examples/group-demo.txt --fast
```

输入 `阿泽: 你好` 模拟群友，直接打字则是「主人」；`:stats` 看统计，`:q` 退出。

## 架构：为什么必须分层

```
你持有的 QQ 账号
      ↓ 登录
协议端（NapCat / Lagrange）      ← 你部署，登录态和密码都留在你本机
      ↓ OneBot v11 WebSocket
src/onebot-adapter.js            ← 本项目的适配器
      ↓
WhaleBot + Memory + Scheduler    ← 人格、记忆、节奏，与 QQ 完全解耦
      ↓
src/tts.js                       ← 语音合成（Edge → SAPI 兜底）
```

适配器只做四件事：收事件 → 判触发 → 调生成 → 发文字或语音。
`src/bot.js` 里没有一行代码知道 QQ 存在，换成别的平台只换适配器。

## ⚠️ 边界（必须先看）

- **封号风险真实存在。** 用不重要的号；先在熟人小群、加白名单跑。
- **话由你负责。** 群里说出去的每一句，责任在账号持有人。
- **凭据不进代码。** Key / Token 只放 `.env.local`，我已把该文件加进 `.gitignore`。
  **不要把它贴给我或任何人。**
- **先文字后语音。** 语音链路依赖协议端支持 `record` 消息段；万一发不出去，
  代码会自动退回文字（已实现）。
- **不做的事**：不操作你已登录的 QQ 客户端、不读它的登录态、不做安卓手机自动化、
  不代你注册或持有账号。

## 还没做

| 项 | 说明 |
|---|---|
| QQ 空间动态 | 接口最不稳定、封号风险最高，建议放最后 |
| 安卓身体（ADB 自动化） | 能做，但要装模拟器；这一步争议最大，需要单独确认 |
| 流式输出 | 可以降低「打字等半天」的体感延迟 |
| 消息并发锁 | 现在是串行 await，极端情况下会排队 |
| 代码级敏感词过滤 | 目前只有提示词约束，没有硬过滤 |
