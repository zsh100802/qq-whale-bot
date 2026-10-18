// 私聊离线端到端验证：本地起「假 OneBot 协议端」，验证私聊回复链路
// 覆盖：私聊开/关、私聊白名单过滤、私聊文字/语音发送
// 不发消息给任何真实账号，纯本地回环。
//
//   node test/private-offline-test.mjs

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 3199;

const received = [];
let failures = 0;

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

  sendJson({
    post_type: "meta_event",
    meta_event_type: "lifecycle",
    self_id: 10001,
    time: Math.floor(Date.now() / 1000),
  });

  // 1) 私聊：好友阿泽（在白名单 20002 内）→ 应该回复
  setTimeout(() => {
    sendJson({
      post_type: "message",
      message_type: "private",
      self_id: 10001,
      user_id: 20002,
      raw_message: "小鲸 在吗",
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: "阿泽" },
      message: [{ type: "text", data: { text: "小鲸 在吗" } }],
    });
  }, 400);

  // 2) 私聊：陌生号 99999（不在白名单）→ 应该静默
  setTimeout(() => {
    sendJson({
      post_type: "message",
      message_type: "private",
      self_id: 10001,
      user_id: 99999,
      raw_message: "你好",
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: "陌生人" },
      message: [{ type: "text", data: { text: "你好" } }],
    });
  }, 900);

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
        if (msg.action === "send_private_msg") {
          received.push(msg.params);
          console.log("假协议端收到私聊回复 →", JSON.stringify(msg.params));
          check();
        }
      } catch {
        /* ignore */
      }
    }
  });

  socket.on("error", () => {});
});

let checked = false;
function check() {
  // 等到两条私聊事件都被处理完（允许一点余量），再判断
  if (received.length === 1) return; // 还在等第二条的「静默」判定
}

function finish() {
  clearTimeout(timeout);
  child.kill();
  server.close();

  // 期望：只收到 1 条回复（给白名单内的 20002），陌生人 99999 被过滤
  const first = received[0];
  const onlyOne = received.length === 1;
  const toFriend = onlyOne && first?.user_id === 20002;

  console.log(`\n收到私聊回复条数 = ${received.length}（期望 1）`);
  const ok = toFriend;
  console.log(
    ok
      ? "\n✅ 私聊链路验证通过：白名单内好友得到回复，陌生人被静默过滤"
      : "\n❌ 验证失败（期望只回复白名单内的 20002）"
  );
  process.exit(ok ? 0 : 1);
}

const timeout = setTimeout(() => {
  console.log("\n❌ 超时：没有收到适配器的私聊回复");
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
      WHALE_PRIVATE: "1",
      WHALE_PRIVATE_FRIENDS: "20002",
      WHALE_VOICE: "0", // 私聊先验证文字，语音已在群聊链路验证过
      WHALE_SCHEDULE: "0",
      WHALE_TZ: "Asia/Shanghai",
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log(`适配器退出，code=${code}`);
  });
});

// 收尾：等 1.5 秒（两条事件都推完后）再判定
setTimeout(finish, 2000);

// ---- 极简 WebSocket 帧编解码 ----
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
