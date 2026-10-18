// 离线端到端验证：本地起一个「假 OneBot 协议端」，验证适配器真正的 WS 收发链路
// 不发消息给任何真实账号，纯本地回环。
//
//   node test/onebot-offline-test.mjs

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 3099;

const received = [];
let t1 = null;

const server = createServer((req, res) => {
  res.writeHead(426);
  res.end("upgrade required");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHashAccept(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const sendJson = (obj) => socket.write(encodeFrame(JSON.stringify(obj)));

  // 1) 握手后推送生命周期事件，让适配器拿到 self_id
  sendJson({
    post_type: "meta_event",
    meta_event_type: "lifecycle",
    self_id: 10001,
    time: Math.floor(Date.now() / 1000),
  });

  t1 = setTimeout(() => {
    // 2) 推一条「@机器人」的群消息
    sendJson({
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      group_id: 888888,
      user_id: 20002,
      raw_message: "小鲸 在吗",
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: "阿泽", card: "" },
      message: [
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: " 在吗" } },
      ],
    });
  }, 400);

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let frame;
    while ((frame = decodeFrame(buf))) {
      buf = frame.rest;
      if (frame.opcode === 0x8) return socket.end();
      if (frame.opcode !== 0x1) continue;
      try {
        const msg = JSON.parse(frame.payload);
        if (msg.action === "send_group_msg") {
          received.push(msg.params);
          console.log("假协议端收到回复 →", JSON.stringify(msg.params));
          finish();
        }
      } catch {
        /* ignore */
      }
    }
  });

  socket.on("error", () => {});
});

function finish() {
  clearTimeout(t1);
  clearTimeout(timeout);
  child.kill();
  server.close();

  const first = received[0];
  const isRecord = Array.isArray(first?.message) && first.message.some((s) => s.type === "record");
  const hasFile = isRecord && first.message[0]?.data?.file?.startsWith("file:///");

  console.log("\n收到回复段：", JSON.stringify(first?.message));
  const ok = first && first.group_id === 888888 && isRecord && hasFile && first.message.length > 0;
  console.log(
    ok
      ? "\n✅ 端到端链路验证通过：事件 → 触发 → 生成 → TTS → send_group_msg(record)"
      : "\n❌ 验证失败（期望收到 record 语音段）"
  );
  process.exit(ok ? 0 : 1);
}

const timeout = setTimeout(() => {
  console.log("\n❌ 超时：没有收到适配器的回复");
  child.kill();
  server.close();
  process.exit(1);
}, 10000);

let child;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`假 OneBot 协议端已监听 ws://127.0.0.1:${PORT}`);
  child = spawn(process.execPath, [join(ROOT, "src", "onebot-adapter.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      ONEBOT_WS: `ws://127.0.0.1:${PORT}`,
      WHALE_GROUPS: "888888",
      WHALE_VOICE: "1",
      WHALE_VOICE_RATE: "1",
      WHALE_SCHEDULE: "0",
      WHALE_TZ: "Asia/Shanghai",
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log(`适配器退出，code=${code}`);
  });
});

// ---- 极简 WebSocket 帧编解码（只处理本测试需要的情况）----
function createHashAccept(key) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function encodeFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

  return { fin, opcode, payload: payload.toString("utf8"), rest: buf.subarray(offset + len) };
}
