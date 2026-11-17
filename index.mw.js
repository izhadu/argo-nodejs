#!/usr/bin/env node

const http = require("http");
const axios = require("axios");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { exec: execCommand, execSync } = require("child_process");
const exec = promisify(execCommand);

// ========================================================
// 1. 全局配置与核心环境变量（完整保留原版 + 自定义扩展）
// ========================================================

// [系统与路由配置]
const FILE_PATH = process.env.FILE_PATH || ".npm";                                   // 运行目录，临时二进制与 sub 节点文件保存目录
const SUB_PATH = process.env.SUB_PATH || "vless";                                    // 订阅链接的路由路径（访问 /vless 获取订阅）
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;                    // HTTP 服务监听端口
const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913";             // 节点唯一身份凭证 (使用哪吒 v1 在不同平台运行需修改，否则会覆盖)

// [订阅上传、自动保活与自定义域名配置]
const UPLOAD_URL = process.env.UPLOAD_URL || "";                                     // 节点或订阅自动上传地址 (需填写部署 Merge-sub 项目后的首页地址)
const PROJECT_URL = process.env.PROJECT_URL || "";                                   // 当前容器分配的公网 URL (用于上传订阅或开启自动保活)
const AUTO_ACCESS = ["true", "1", "yes"].includes(                                   // 自动保活开关：修复原版字符串 'false' 被当成 true 的 Bug
  String(process.env.AUTO_ACCESS || "false").toLowerCase()
);
const MY_WEB_DOMAIN = process.env.MY_WEB_DOMAIN || "vls-wispbyte.wct.kdns.fr";       // 自定义 Web 订阅域名，系统会自动拼接 https:// 和 SUB_PATH 保存至本地

// [Cloudflare Argo 隧道配置]
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "wispbyte.wct.kdns.fr";               // 固定隧道域名，留空则自动启用 trycloudflare 临时隧道
const ARGO_AUTH = process.env.ARGO_AUTH || "eyJhIjoiOGI0YjkxZDNiNWNjZGMzNDEzM2I4MTljOGM1OWRiZGQiLCJ0IjoiOGU5M2YwZjItYjU4YS00M2M2LThkYzAtMGVlZjFlNzE2NmNlIiwicyI6Ik5EZ3hPR0l4WkdZdE1EazBOeTAwTWpBMExUZzJObVF0TkRjMk5tWmtaalJpTmpSbCJ9"; // 固定隧道 Token 或 JSON 配置
const ARGO_PORT = parseInt(process.env.ARGO_PORT || 8001, 10);                       // 固定隧道本地转发端口 (使用 Token 时需与 Cloudflare 后台设置保持一致)

// [节点伪装与优选配置]
const CFIP = process.env.CFIP || "cf.saas.zhadu.com";                                // 节点 Cloudflare 优选域名或优选 IP
const CFPORT = parseInt(process.env.CFPORT || 443, 10);                              // 节点优选域名或优选 IP 对应的端口
const NAME = process.env.NAME || "vless";                                            // 节点名称前缀

// [多协议直连端口配置 (支持多端口的容器平台可填写纯数字端口号，否则留空)]
const S5_PORT = process.env.S5_PORT || "";                                           // Socks5 直连端口
const HY2_PORT = process.env.HY2_PORT || "";                                         // Hysteria2 直连端口
const REALITY_PORT = process.env.REALITY_PORT || "";                                 // VLESS-Reality 直连端口

// [Nezha (哪吒探针) 配置]
const NEZHA_SERVER = process.env.NEZHA_SERVER || "";                                 // 探针服务端地址 (v1 填 域名:端口，v0 仅填 域名)
const NEZHA_PORT = process.env.NEZHA_PORT || "";                                     // 探针 RPC 端口 (v1 请留空，v0 需填写)
const NEZHA_KEY = process.env.NEZHA_KEY || "";                                       // 探针密钥 (v1 的 NZ_CLIENT_SECRET 或 v0 的 agent 密钥)

// [Telegram 机器人推送配置 (两个变量均填写时才推送，留空不推送)]
const CHAT_ID = process.env.CHAT_ID || "";                                           // Telegram 接收消息的 chat_id
const BOT_TOKEN = process.env.BOT_TOKEN || "";                                       // Telegram 机器人的 bot_token

// [日志输出控制]
const SHOW_LOG = !["false", "disable", "no"].includes(                               // 是否显示运行日志：true/yes 显示，false/disable/no 屏蔽
  String(process.env.SHOW_LOG || "true").toLowerCase()
);

if (!SHOW_LOG) {
  console.log = () => {};
  console.error = () => {};
}
function alwaysLog(msg) {
  process.stdout.write(`${msg}\n`);
}

// ========================================================
// 2. 初始化运行目录、全局路径与基础辅助函数
// ========================================================

// 确保运行工作目录存在
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

// 校验端口号是否为 1-65535 之间的有效整数
function isValidPort(port) {
  if (port === null || port === undefined || String(port).trim() === "") return false;
  const portNum = Number(port);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

// 生成随机 6 位小写字母文件名，用于混淆二进制进程名
function generateRandomName(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length: len }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
}

const npmName = generateRandomName(); // 哪吒 v0 二进制文件名
const phpName = generateRandomName(); // 哪吒 v1 二进制文件名
const webName = generateRandomName(); // Xray 二进制文件名
const botName = generateRandomName(); // Cloudflared 二进制文件名

// 统一管理所有文件路径
const paths = {
  npm: path.join(FILE_PATH, npmName),
  php: path.join(FILE_PATH, phpName),
  web: path.join(FILE_PATH, webName),
  bot: path.join(FILE_PATH, botName),
  sub: path.join(FILE_PATH, "sub.txt"),
  list: path.join(FILE_PATH, "list.txt"),
  webUrl: path.join(FILE_PATH, "web_url.txt"),
  bootLog: path.join(FILE_PATH, "boot.log"),
  config: path.join(FILE_PATH, "config.json"),
  keyTxt: path.join(FILE_PATH, "key.txt"),
  cert: path.resolve(FILE_PATH, "cert.pem"),
  key: path.resolve(FILE_PATH, "private.key"),
  tunnelJson: path.join(FILE_PATH, "tunnel.json"),
  tunnelYml: path.join(FILE_PATH, "tunnel.yml"),
  nezhaYaml: path.join(FILE_PATH, "config.yaml"),
};

let subContent = null;
let privateKey = "";
let publicKey = "";

// 如果订阅器 (Merge-sub) 上存在上次运行残留的节点，先发起请求将其删除
async function deleteNodes() {
  try {
    if (!UPLOAD_URL || !fs.existsSync(paths.sub)) return;
    const fileContent = fs.readFileSync(paths.sub, "utf-8");
    const decoded = Buffer.from(fileContent, "base64").toString("utf-8");
    const nodes = decoded.split("\n").filter((line) => /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line));
    if (nodes.length === 0) return;

    await axios.post(
      `${UPLOAD_URL}/api/delete-nodes`,
      JSON.stringify({ nodes }),
      { headers: { "Content-Type": "application/json" }, timeout: 5000 }
    ).catch(() => {});
  } catch (err) {}
}

// 清理历史运行残留文件（白名单保留 key.txt，防止重启后 Reality 公钥改变导致客户端失联）
function cleanupOldFiles() {
  try {
    const preserveFiles = new Set(["key.txt"]);
    const files = fs.readdirSync(FILE_PATH);
    files.forEach((file) => {
      if (preserveFiles.has(file)) return;
      const fullPath = path.join(FILE_PATH, file);
      try {
        if (fs.statSync(fullPath).isFile()) fs.unlinkSync(fullPath);
      } catch (err) {}
    });
  } catch (err) {}
}

// ========================================================
// 3. 加密密钥 (X25519) 与 TLS 证书管理
// ========================================================

// 使用 Node.js 原生 crypto 生成 Reality 所需的 X25519 公私钥对
function generateX25519Keypair() {
  const { publicKey: pubKey, privateKey: privKey } = crypto.generateKeyPairSync("x25519");
  const privateKeyRaw = privKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const publicKeyRaw = pubKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    privateKey: privateKeyRaw.toString("base64url"),
    publicKey: publicKeyRaw.toString("base64url"),
  };
}

// 加载已有的 X25519 密钥对，若不存在则生成并持久化保存到 key.txt
function generateOrLoadKeyPair() {
  if (fs.existsSync(paths.keyTxt)) {
    const content = fs.readFileSync(paths.keyTxt, "utf8");
    const privMatch = content.match(/PrivateKey:\s*(.*)/);
    const pubMatch = content.match(/PublicKey:\s*(.*)/);
    if (privMatch && pubMatch) {
      privateKey = privMatch[1].trim();
      publicKey = pubMatch[1].trim();
      console.log("Loaded existing X25519 Public Key:", publicKey);
      return;
    }
  }
  const keypair = generateX25519Keypair();
  privateKey = keypair.privateKey;
  publicKey = keypair.publicKey;
  fs.writeFileSync(paths.keyTxt, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`, "utf8");
  console.log("Generated new X25519 Public Key:", publicKey);
}

// 当系统无 openssl 时使用的兜底自签名证书与私钥 (供 Hysteria2 使用)
const FALLBACK_EC_KEY =
  "-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49\nAwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa\n/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==\n-----END EC PRIVATE KEY-----\n";
const FALLBACK_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw\nEzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy\nMDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH\nA0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h\naD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR\nBfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB\nAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+\neQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==\n-----END CERTIFICATE-----\n";

// 生成 TLS 自签名证书（优先调用 openssl 动态生成，失败则写入兜底证书）
function ensureTlsCertificates() {
  if (fs.existsSync(paths.cert) && fs.existsSync(paths.key)) return;
  fs.mkdirSync(path.dirname(paths.cert), { recursive: true });
  try {
    execSync("openssl version", { stdio: "ignore" });
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${paths.key}"`, { stdio: "ignore" });
    execSync(`openssl req -new -x509 -days 3650 -key "${paths.key}" -out "${paths.cert}" -subj "/CN=bing.com"`, { stdio: "ignore" });
    return;
  } catch (e) {
    fs.writeFileSync(paths.key, FALLBACK_EC_KEY);
    fs.writeFileSync(paths.cert, FALLBACK_CERT);
  }
}

// 计算证书的 SHA-256 指纹（优先用 openssl，不可用时使用 Node.js crypto 兜底）
function getCertificateFingerprint() {
  try {
    const result = execSync(`openssl x509 -noout -fingerprint -sha256 -in "${paths.cert}"`, {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    const match = result.match(/=(.+)$/);
    if (match && match[1]) return match[1].toUpperCase();
  } catch (e) {}

  try {
    const certData = fs.readFileSync(paths.cert, "utf8");
    const derMatch = certData.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
    if (!derMatch) return "";
    const derBuffer = Buffer.from(derMatch[1].replace(/\s/g, ""), "base64");
    const hash = crypto.createHash("sha256").update(derBuffer).digest("hex");
    return hash.match(/.{2}/g).join(":").toUpperCase();
  } catch (error) {
    console.error("Failed to calculate certificate fingerprint:", error);
    return "";
  }
}

// ========================================================
// 4. 生成 Xray 与 Cloudflared 配置文件
// ========================================================

// 生成 Xray 服务端配置 (含 TCP KeepAlive 优化与多协议分流)
async function generateConfig() {
  const commonSockopt = {
    tcpFastOpen: true,
    tcpKeepAliveInterval: 30,
  };

  const config = {
    log: { access: "/dev/null", error: "/dev/null", loglevel: "none" },
    inbounds: [
      {
        tag: "vless-fallback-in",
        port: ARGO_PORT,
        listen: "::",
        protocol: "vless",
        settings: {
          clients: [{ id: UUID, flow: "xtls-rprx-vision" }],
          decryption: "none",
          fallbacks: [
            { dest: 3001 },
            { path: "/vless-argo", dest: 3002 },
            { path: "/vmess-argo", dest: 3003 },
            { path: "/trojan-argo", dest: 3004 },
          ],
        },
        streamSettings: { network: "tcp", sockopt: commonSockopt },
      },
      {
        tag: "vless-tcp-in",
        port: 3001,
        listen: "127.0.0.1",
        protocol: "vless",
        settings: { clients: [{ id: UUID }], decryption: "none" },
        streamSettings: { network: "tcp", security: "none", sockopt: commonSockopt },
      },
      {
        tag: "vless-ws-in",
        port: 3002,
        listen: "127.0.0.1",
        protocol: "vless",
        settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" }, sockopt: commonSockopt },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false },
      },
      {
        tag: "vmess-ws-in",
        port: 3003,
        listen: "127.0.0.1",
        protocol: "vmess",
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vmess-argo" }, sockopt: commonSockopt },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false },
      },
      {
        tag: "trojan-ws-in",
        port: 3004,
        listen: "127.0.0.1",
        protocol: "trojan",
        settings: { clients: [{ password: UUID }] },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" }, sockopt: commonSockopt },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false },
      },
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query", "https+local://1.1.1.1/dns-query"] },
    outbounds: [
      { protocol: "freedom", tag: "direct", streamSettings: { sockopt: commonSockopt } },
      { protocol: "blackhole", tag: "block" },
    ],
  };

  // 若配置了有效 REALITY_PORT，追加 VLESS-Reality 直连入站
  if (isValidPort(REALITY_PORT)) {
    config.inbounds.push({
      tag: "vless-in",
      listen: "::",
      port: parseInt(REALITY_PORT, 10),
      protocol: "vless",
      settings: { clients: [{ id: UUID, flow: "xtls-rprx-vision" }], decryption: "none" },
      streamSettings: {
        network: "raw",
        security: "reality",
        sockopt: commonSockopt,
        realitySettings: {
          show: false,
          dest: "www.iij.ad.jp:443",
          xver: 0,
          serverNames: ["www.iij.ad.jp"],
          privateKey: privateKey,
          shortIds: [""],
        },
      },
    });
  }

  // 若配置了有效 HY2_PORT，追加 Hysteria2 直连入站
  if (isValidPort(HY2_PORT)) {
    config.inbounds.push({
      tag: "hysteria-in",
      listen: "::",
      port: parseInt(HY2_PORT, 10),
      protocol: "hysteria",
      settings: { version: 2, clients: [{ auth: UUID }] },
      streamSettings: {
        network: "hysteria",
        hysteriaSettings: { version: 2, masquerade: { type: "proxy", url: "https://bing.com" } },
        security: "tls",
        tlsSettings: { alpn: ["h3"], certificates: [{ certificateFile: paths.cert, keyFile: paths.key }] },
      },
    });
  }

  // 若配置了有效 S5_PORT，追加 Socks5 直连入站
  if (isValidPort(S5_PORT)) {
    config.inbounds.push({
      tag: "s5-in",
      listen: "::",
      port: parseInt(S5_PORT, 10),
      protocol: "socks",
      settings: {
        auth: "password",
        accounts: [{ user: UUID.substring(0, 8), pass: UUID.slice(-12) }],
        udp: true,
      },
    });
  }

  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2));
}

// 识别固定隧道认证类型并生成 tunnel.json 与 tunnel.yml
function argoType() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    console.log("ARGO_DOMAIN or ARGO_AUTH is empty, use quick tunnels");
    return;
  }

  if (ARGO_AUTH.includes("TunnelSecret")) {
    try {
      // 使用 JSON.parse 替代原版脆弱的 split('"')[11]，防止 JSON 字段顺序变化导致失败
      const authObj = JSON.parse(ARGO_AUTH);
      const tunnelId = authObj.TunnelID || ARGO_AUTH.split('"')[11];
      fs.writeFileSync(paths.tunnelJson, ARGO_AUTH);
      const tunnelYaml = [
        `tunnel: ${tunnelId}`,
        `credentials-file: ${paths.tunnelJson}`,
        `protocol: http2`,
        ``,
        `ingress:`,
        `  - hostname: ${ARGO_DOMAIN}`,
        `    service: http://localhost:${ARGO_PORT}`,
        `    originRequest:`,
        `      noTLSVerify: true`,
        `  - service: http_status:404`,
      ].join("\n");
      fs.writeFileSync(paths.tunnelYml, tunnelYaml);
    } catch (e) {
      console.error("Failed to parse ARGO_AUTH JSON:", e.message);
    }
  } else {
    console.log(`Using token connect to tunnel, please set ${ARGO_PORT} in cloudflare`);
  }
}

// ========================================================
// 5. 依赖二进制文件下载与进程启动 (含主备双源防失联)
// ========================================================

// 判断当前 CPU 架构
function getSystemArchitecture() {
  const arch = os.arch();
  return ["arm", "arm64", "aarch64"].includes(arch) ? "arm" : "amd";
}

// 根据系统架构返回所需下载的二进制文件及主备下载地址
function getFilesForArchitecture(architecture) {
  const baseUrl = architecture === "arm" ? "https://arm64.oooen.com" : "https://amd64.oooen.com";
  const backupUrl = architecture === "arm" ? "https://arm64.ssss.nyc.mn" : "https://amd64.ssss.nyc.mn";

  const baseFiles = [
    { fileName: paths.web, fileUrls: [`${baseUrl}/web`, `${backupUrl}/web`] },
    { fileName: paths.bot, fileUrls: [`${baseUrl}/bot`, `${backupUrl}/bot`] },
  ];

  if (NEZHA_SERVER && NEZHA_KEY) {
    if (NEZHA_PORT) {
      baseFiles.unshift({ fileName: paths.npm, fileUrls: [`${baseUrl}/agent`, `${backupUrl}/agent`] });
    } else {
      baseFiles.unshift({ fileName: paths.php, fileUrls: [`${baseUrl}/v1`, `${backupUrl}/v1`] });
    }
  }
  return baseFiles;
}

// 单个文件流式下载函数 (加入 30s 超时防止网络死锁)
function downloadFile(fileName, fileUrl, callback) {
  const tempFilePath = `${fileName}.download`;
  const writer = fs.createWriteStream(tempFilePath);

  axios({
    method: "get",
    url: fileUrl,
    responseType: "stream",
    timeout: 30000,
  })
    .then((response) => {
      response.data.pipe(writer);
      writer.on("finish", () => {
        writer.close((closeError) => {
          if (closeError) {
            fs.unlink(tempFilePath, () => {});
            callback(`Download ${path.basename(fileName)} failed: ${closeError.message}`);
            return;
          }
          try {
            fs.renameSync(tempFilePath, fileName);
            console.log(`Download ${path.basename(fileName)} successfully`);
            callback(null, fileName);
          } catch (renameError) {
            fs.unlink(tempFilePath, () => {});
            callback(`Download ${path.basename(fileName)} failed: ${renameError.message}`);
          }
        });
      });
      writer.on("error", (err) => {
        fs.unlink(tempFilePath, () => {});
        callback(`Download ${path.basename(fileName)} failed: ${err.message}`);
      });
    })
    .catch((err) => {
      fs.unlink(tempFilePath, () => {});
      callback(`Download ${path.basename(fileName)} failed: ${err.message}`);
    });
}

// 批量下载文件并依次拉起 Nezha、Xray、Cloudflared 服务
async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const filesToDownload = getFilesForArchitecture(architecture);

  const downloadPromises = filesToDownload.map((fileInfo) => {
    return new Promise((resolve, reject) => {
      const tryDownload = (urlIndex) => {
        downloadFile(fileInfo.fileName, fileInfo.fileUrls[urlIndex], (err, filePath) => {
          if (!err) {
            resolve(filePath);
            return;
          }
          if (urlIndex + 1 < fileInfo.fileUrls.length) {
            console.log(`Retrying ${path.basename(fileInfo.fileName)} from backup source`);
            tryDownload(urlIndex + 1);
            return;
          }
          reject(err);
        });
      };
      tryDownload(0);
    });
  });

  try {
    await Promise.all(downloadPromises);
  } catch (err) {
    console.error("Error downloading files:", err);
    return;
  }

  // 赋予可执行权限 (0o775)
  const filesToAuthorize = NEZHA_PORT ? [paths.npm, paths.web, paths.bot] : [paths.php, paths.web, paths.bot];
  filesToAuthorize.forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      try {
        fs.chmodSync(filePath, 0o775);
        console.log(`Empowerment success for ${filePath}: 775`);
      } catch (err) {
        console.error(`Empowerment failed for ${filePath}: ${err}`);
      }
    }
  });

  // 1. 启动哪吒探针 (自动区分 v1 与 v0)
  if (NEZHA_SERVER && NEZHA_KEY) {
    if (!NEZHA_PORT) {
      const port = NEZHA_SERVER.includes(":") ? NEZHA_SERVER.split(":").pop() : "";
      const tlsPorts = new Set(["443", "8443", "2096", "2087", "2083", "2053"]);
      const nezhatls = tlsPorts.has(port) ? "true" : "false";
      const configYaml = [
        `client_secret: ${NEZHA_KEY}`,
        `debug: false`,
        `disable_auto_update: true`,
        `disable_command_execute: false`,
        `disable_force_update: true`,
        `disable_nat: false`,
        `disable_send_query: false`,
        `gpu: false`,
        `insecure_tls: true`,
        `ip_report_period: 1800`,
        `report_delay: 4`,
        `server: ${NEZHA_SERVER}`,
        `skip_connection_count: true`,
        `skip_procs_count: true`,
        `temperature: false`,
        `tls: ${nezhatls}`,
        `use_gitee_to_upgrade: false`,
        `use_ipv6_country_code: false`,
        `uuid: ${UUID}`,
      ].join("\n");

      fs.writeFileSync(paths.nezhaYaml, configYaml);
      try {
        await exec(`nohup "${paths.php}" -c "${paths.nezhaYaml}" >/dev/null 2>&1 &`);
        console.log(`${phpName} is running`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`php running error: ${error}`);
      }
    } else {
      const tlsPorts = ["443", "8443", "2096", "2087", "2083", "2053"];
      const NEZHA_TLS = tlsPorts.includes(NEZHA_PORT) ? "--tls" : "";
      const command = `nohup "${paths.npm}" -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`;
      try {
        await exec(command);
        console.log(`${npmName} is running`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`npm running error: ${error}`);
      }
    }
  } else {
    console.log("NEZHA variable is empty, skip running");
  }

  // 2. 启动 Xray 核心
  try {
    await exec(`nohup "${paths.web}" -c "${paths.config}" >/dev/null 2>&1 &`);
    console.log(`${webName} is running`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(`web running error: ${error}`);
  }

  // 3. 启动 Cloudflared 隧道
  if (fs.existsSync(paths.bot)) {
    let args;
    if (/^[A-Za-z0-9=_-]{120,500}$/.test(ARGO_AUTH)) {
      args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
    } else if (ARGO_AUTH.includes("TunnelSecret")) {
      args = `tunnel --edge-ip-version auto --config "${paths.tunnelYml}" run`;
    } else {
      args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile "${paths.bootLog}" --loglevel info --url http://localhost:${ARGO_PORT}`;
    }

    try {
      await exec(`nohup "${paths.bot}" ${args} >/dev/null 2>&1 &`);
      console.log(`${botName} is running`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error executing cloudflared: ${error}`);
    }
  }
}

// ========================================================
// 6. 隧道域名提取与差异化节点订阅生成
// ========================================================

// 轮询等待临时隧道日志文件输出 trycloudflare.com 域名 (最长等待 30 秒)
async function waitForQuickTunnelLog(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(paths.bootLog)) {
        const content = fs.readFileSync(paths.bootLog, "utf-8");
        if (/trycloudflare\.com/.test(content)) return content;
      }
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return "";
}

// 提取隧道域名（支持固定隧道直接生成与临时隧道自动重试）
async function extractDomains(retryCount = 0) {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    console.log("ARGO_DOMAIN:", ARGO_DOMAIN);
    await generateLinks(ARGO_DOMAIN);
    return;
  }

  try {
    const fileContent = await waitForQuickTunnelLog();
    const lines = fileContent.split("\n");
    const argoDomains = [];
    lines.forEach((line) => {
      const domainMatch = line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
      if (domainMatch) argoDomains.push(domainMatch[1]);
    });

    if (argoDomains.length > 0) {
      const argoDomain = argoDomains[0];
      console.log("ArgoDomain:", argoDomain);
      await generateLinks(argoDomain);
    } else {
      if (retryCount >= 3) {
        console.error("Failed to obtain ArgoDomain after maximum retries.");
        return;
      }
      console.log("ArgoDomain not found, re-running bot to obtain ArgoDomain");
      if (fs.existsSync(paths.bootLog)) fs.unlinkSync(paths.bootLog);
      try {
        if (process.platform === "win32") {
          await exec(`taskkill /f /im ${botName}.exe > nul 2>&1`);
        } else {
          await exec(`pkill -f "[${botName.charAt(0)}]${botName.substring(1)}" > /dev/null 2>&1`);
        }
      } catch (error) {}

      await new Promise((resolve) => setTimeout(resolve, 3000));
      const args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile "${paths.bootLog}" --loglevel info --url http://localhost:${ARGO_PORT}`;
      await exec(`nohup "${paths.bot}" ${args} >/dev/null 2>&1 &`);
      console.log(`${botName} is running`);
      await extractDomains(retryCount + 1);
    }
  } catch (error) {
    console.error("Error reading boot.log:", error);
  }
}

// 获取当前服务器所在国家代码与 ISP 运营商信息 (修复了原版将 timeout 写进 headers 的 Bug)
async function getMetaInfo() {
  try {
    const response1 = await axios.get("https://api.ip.sb/geoip", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 3000,
    });
    if (response1.data && response1.data.country_code && response1.data.isp) {
      return `${response1.data.country_code}-${response1.data.isp}`.replace(/\s+/g, "_");
    }
  } catch (error) {
    try {
      const response2 = await axios.get("http://ip-api.com/json", {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 3000,
      });
      if (response2.data && response2.data.status === "success" && response2.data.countryCode && response2.data.org) {
        return `${response2.data.countryCode}-${response2.data.org}`.replace(/\s+/g, "_");
      }
    } catch (err) {}
  }
  return "Unknown";
}

// 获取服务器公网 IP (完整保留原版 axios + curl 命令行双重兜底，兼容纯 IPv6 环境)
async function getServerIP() {
  try {
    return (await axios.get("http://ipv4.ip.sb", { timeout: 3000 })).data.trim();
  } catch (err) {
    try {
      return execSync("curl -sm 3 ipv4.ip.sb").toString().trim();
    } catch (curlErr) {
      try {
        return `[${(await axios.get("http://ipv6.ip.sb", { timeout: 3000 })).data.trim()}]`;
      } catch (ipv6AxiosErr) {
        try {
          return `[${execSync("curl -sm 3 ipv6.ip.sb").toString().trim()}]`;
        } catch (ipv6CurlErr) {
          console.error("Failed to get IP address:", ipv6CurlErr.message);
          return ARGO_DOMAIN || CFIP || "127.0.0.1";
        }
      }
    }
  }
}

// 生成各协议差异化名称的节点链接，并保存 sub.txt、list.txt 与 web_url.txt
async function generateLinks(argoDomain) {
  const ISP = await getMetaInfo();
  const basePrefix = NAME ? `${NAME}-${ISP}` : ISP;
  const SERVER_IP = await getServerIP();

  return new Promise((resolve) => {
    setTimeout(async () => {
      // 为不同协议赋予独立节点名称，避免客户端列表重名混淆或被订阅转换工具去重丢弃
      const nameVless = `${basePrefix}-VLESS-Argo`;
      const nameVmess = `${basePrefix}-VMess-Argo`;
      const nameTrojan = `${basePrefix}-Trojan-Argo`;
      const nameHy2 = `${basePrefix}-HY2-直连`;
      const nameReality = `${basePrefix}-Reality-直连`;
      const nameSocks = `${basePrefix}-Socks5`;

      const VMESS = {
        v: "2",
        ps: nameVmess,
        add: CFIP,
        port: CFPORT,
        id: UUID,
        aid: "0",
        scy: "zero", // 外层已有 Cloudflare TLS，内层设为 zero 降低容器 CPU 开销
        net: "ws",
        type: "none",
        host: argoDomain,
        path: "/vmess-argo?ed=2560",
        tls: "tls",
        sni: argoDomain,
        alpn: "",
        fp: "firefox",
      };

      const nodeList = [
        `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${encodeURIComponent(nameVless)}`,
        `vmess://${Buffer.from(JSON.stringify(VMESS)).toString("base64")}`,
        `trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${encodeURIComponent(nameTrojan)}`,
      ];

      // 若开启 HY2_PORT，生成 Hysteria2 节点
      if (isValidPort(HY2_PORT)) {
        const fingerprint = getCertificateFingerprint();
        const fingerprintParam = fingerprint ? `&pinSHA256=${encodeURIComponent(fingerprint)}` : "";
        nodeList.push(
          `hysteria2://${UUID}@${SERVER_IP}:${HY2_PORT}/?sni=www.bing.com&insecure=0&alpn=h3&obfs=none${fingerprintParam}#${encodeURIComponent(nameHy2)}`
        );
      }

      // 若开启 REALITY_PORT，生成 VLESS-Reality 节点
      if (isValidPort(REALITY_PORT)) {
        nodeList.push(
          `vless://${UUID}@${SERVER_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.iij.ad.jp&fp=firefox&pbk=${publicKey}&type=tcp&headerType=none#${encodeURIComponent(nameReality)}`
        );
      }

      // 若开启 S5_PORT，生成 Socks5 节点
      if (isValidPort(S5_PORT)) {
        const S5_AUTH = Buffer.from(`${UUID.substring(0, 8)}:${UUID.slice(-12)}`).toString("base64");
        nodeList.push(`socks://${S5_AUTH}@${SERVER_IP}:${S5_PORT}#${encodeURIComponent(nameSocks)}`);
      }

      const subTxt = nodeList.join("\n");
      subContent = Buffer.from(subTxt).toString("base64");

      console.log(subContent);
      fs.writeFileSync(paths.sub, subContent);
      fs.writeFileSync(paths.list, subTxt, "utf8");
      console.log(`${paths.sub} saved successfully`);

      // 保留你的自定义优化：将 Web 订阅服务的访问链接写入到本地 web_url.txt 文件中
      const webAccessUrl = MY_WEB_DOMAIN
        ? `https://${MY_WEB_DOMAIN}/${SUB_PATH}`
        : PROJECT_URL
        ? `https://${PROJECT_URL}/${SUB_PATH}`
        : `http://${SERVER_IP}:${PORT}/${SUB_PATH}`;
      fs.writeFileSync(paths.webUrl, `Web 订阅服务链接: ${webAccessUrl}\n`, "utf8");
      alwaysLog(`[INFO] Web 链接已保存至: ${paths.webUrl} -> ${webAccessUrl}`);

      await uploadNodes();
      resolve(subTxt);
    }, 2000);
  });
}

// ========================================================
// 7. 附加自动化功能：节点上传、TG 推送、网页保活与定时清理
// ========================================================

// 自动上传节点或订阅至 Merge-sub 汇聚面板
async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    const subscriptionUrl = `${PROJECT_URL}/${SUB_PATH}`;
    try {
      const response = await axios.post(
        `${UPLOAD_URL}/api/add-subscriptions`,
        { subscription: [subscriptionUrl] },
        { headers: { "Content-Type": "application/json" }, timeout: 5000 }
      );
      if (response && response.status === 200) {
        console.log("Subscription uploaded successfully");
      }
    } catch (error) {}
  } else if (UPLOAD_URL) {
    if (!fs.existsSync(paths.list)) return;
    const content = fs.readFileSync(paths.list, "utf-8");
    const nodes = content.split("\n").filter((line) => /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line));
    if (nodes.length === 0) return;

    try {
      const response = await axios.post(
        `${UPLOAD_URL}/api/add-nodes`,
        JSON.stringify({ nodes }),
        { headers: { "Content-Type": "application/json" }, timeout: 5000 }
      );
      if (response && response.status === 200) {
        console.log("Nodes uploaded successfully");
      }
    } catch (error) {}
  }
}

// [补齐原版功能] 推送 Base64 订阅内容到 Telegram Bot
async function sendTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TG variables is empty, Skipping push nodes to TG");
    return;
  }
  try {
    const message = fs.readFileSync(paths.sub, "utf8");
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const escapedName = NAME.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
    const params = {
      chat_id: CHAT_ID,
      text: `*${escapedName}节点推送*\n\`\`\`\n${message}\n\`\`\``,
      parse_mode: "MarkdownV2",
    };
    await axios.post(url, null, { params, timeout: 5000 });
    console.log("Telegram message sent successfully");
  } catch (error) {
    console.error("Failed to send Telegram message:", error.message);
  }
}

// [补齐原版功能] 自动添加外部定时访问任务实现容器保活
async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    console.log("Skipping adding automatic access task");
    return;
  }
  try {
    const response = await axios.post(
      "https://oooo.serv00.net/add-url",
      { url: PROJECT_URL },
      { headers: { "Content-Type": "application/json" }, timeout: 5000 }
    );
    console.log("automatic access task added successfully");
    return response;
  } catch (error) {
    console.error(`Add automatic access task failed: ${error.message}`);
    return null;
  }
}

// 服务启动完成后延迟 90 秒清理敏感配置文件与二进制文件，并清屏保护日志
function scheduleCleanFiles() {
  setTimeout(() => {
    const filesToDelete = [
      paths.bootLog,
      paths.config,
      paths.web,
      paths.bot,
      paths.list,
      paths.cert,
      paths.key,
      paths.tunnelJson,
      paths.tunnelYml,
      paths.nezhaYaml,
    ];

    if (NEZHA_PORT) {
      filesToDelete.push(paths.npm);
    } else if (NEZHA_SERVER && NEZHA_KEY) {
      filesToDelete.push(paths.php);
    }

    const cmd =
      process.platform === "win32"
        ? `del /f /q ${filesToDelete.join(" ")} > nul 2>&1`
        : `rm -rf ${filesToDelete.join(" ")} >/dev/null 2>&1`;

    exec(cmd, () => {
      console.clear();
      alwaysLog("App is running");
      console.log("Thank you for using this script, enjoy!");
    });
  }, 90000);
}

// ========================================================
// 8. 主运行流程与 HTTP 订阅/伪装服务器
// ========================================================

async function startserver() {
  try {
    // 1. 必须先上报删除旧节点，再清理旧文件（修复原版先删文件导致 deleteNodes 失效的 Bug）
    await deleteNodes();
    cleanupOldFiles();

    // 2. 初始化隧道配置、Reality 密钥对与 Hysteria2 证书
    argoType();
    if (isValidPort(REALITY_PORT)) {
      generateOrLoadKeyPair();
    }
    if (isValidPort(HY2_PORT)) {
      ensureTlsCertificates();
    }

    // 3. 生成配置、下载运行组件、提取域名生成订阅
    await generateConfig();
    await downloadFilesAndRun();
    await extractDomains();

    // 4. 执行 TG 推送与自动保活注册，并挂载延迟清理任务
    await sendTelegram();
    await AddVisitTask();
    scheduleCleanFiles();
  } catch (error) {
    console.error("Error in startserver:", error);
  }
}

// 创建 HTTP 服务器（包含内存读取 + 本地 sub.txt 文件兜底读取）
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  // 订阅路由：优先返回内存中的 subContent，若无则回退读取磁盘 sub.txt
  if (urlPath === `/${SUB_PATH}`) {
    if (subContent) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(subContent);
    } else {
      try {
        const fileContent = fs.readFileSync(paths.sub, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(fileContent);
      } catch (err) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Subscription content not yet available, please try again later.");
      }
    }
    return;
  }

  // 根路由：优先渲染伪装页面 index.html
  if (urlPath === "/") {
    try {
      const filePath = path.join(__dirname, "index.html");
      const data = await fs.promises.readFile(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch (err) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`Hello world!<br><br>You can access /${SUB_PATH} to get your nodes!`);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  alwaysLog(`http server is running on ${PORT}!`);
  startserver().catch((error) => {
    console.error("Unhandled error in startserver:", error);
  });
});