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
// 1. 全局配置与核心环境变量
// ========================================================

// [系统与路由配置]
const FILE_PATH = process.env.FILE_PATH || ".npm";
const SUB_PATH = process.env.SUB_PATH || "vless";
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const UUID = process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913";

// [自动化附加功能配置]
const UPLOAD_URL = process.env.UPLOAD_URL || "";
const PROJECT_URL = process.env.PROJECT_URL || "";
const MY_WEB_DOMAIN = process.env.MY_WEB_DOMAIN || "vls-wispbyte.wct.kdns.fr";

// [Cloudflare Argo 隧道配置]
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "wispbyte.wct.kdns.fr";
const ARGO_AUTH = process.env.ARGO_AUTH || "eyJhIjoiOGI0YjkxZDNiNWNjZGMzNDEzM2I4MTljOGM1OWRiZGQiLCJ0IjoiOGU5M2YwZjItYjU4YS00M2M2LThkYzAtMGVlZjFlNzE2NmNlIiwicyI6Ik5EZ3hPR0l4WkdZdE1EazBOeTAwTWpBMExUZzJObVF0TkRjMk5tWmtaalJpTmpSbCJ9";
const ARGO_PORT = parseInt(process.env.ARGO_PORT || 8001, 10);

// [节点伪装与优选配置]
const CFIP = process.env.CFIP || "cf.saas.zhadu.com";
const CFPORT = parseInt(process.env.CFPORT || 443, 10);
const NAME = process.env.NAME || "vless";

// [多协议直连端口]
const S5_PORT = process.env.S5_PORT || "";
const HY2_PORT = process.env.HY2_PORT || "";
const REALITY_PORT = process.env.REALITY_PORT || "";

// [Nezha (哪吒探针) 配置]
const NEZHA_SERVER = process.env.NEZHA_SERVER || "";
const NEZHA_PORT = process.env.NEZHA_PORT || "";
const NEZHA_KEY = process.env.NEZHA_KEY || "";

// [日志控制]
const SHOW_LOG = !["false", "disable", "no"].includes((process.env.SHOW_LOG || "true").toLowerCase());

if (!SHOW_LOG) {
  console.log = () => {};
  console.error = () => {};
}
function alwaysLog(msg) {
  process.stdout.write(`${msg}\n`);
}

// ========================================================
// 2. 路径定义与工具函数
// ========================================================

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

function generateRandomName(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length: len }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
}

function isValidPort(port) {
  const portNum = Number(port);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

const npmName = generateRandomName();
const webName = generateRandomName();
const botName = generateRandomName();
const phpName = generateRandomName();

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

// 清理历史旧节点与遗留文件（保留 key.txt 防止 Reality 密钥重置）
async function deleteOldNodes() {
  if (!UPLOAD_URL || !fs.existsSync(paths.sub)) return;
  try {
    const fileContent = fs.readFileSync(paths.sub, "utf-8");
    const decoded = Buffer.from(fileContent, "base64").toString("utf-8");
    const nodes = decoded.split("\n").filter((line) => /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line));
    if (nodes.length === 0) return;
    await axios.post(`${UPLOAD_URL}/api/delete-nodes`, { nodes }, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
    }).catch(() => {});
  } catch (err) {}
}

function cleanupOldFiles() {
  try {
    const preserveFiles = new Set(["key.txt"]);
    const files = fs.readdirSync(FILE_PATH);
    for (const file of files) {
      if (preserveFiles.has(file)) continue;
      const fullPath = path.join(FILE_PATH, file);
      try {
        if (fs.statSync(fullPath).isFile()) fs.unlinkSync(fullPath);
      } catch (err) {}
    }
  } catch (err) {}
}

// 证书与密钥管理
function generateOrLoadKeyPair() {
  if (fs.existsSync(paths.keyTxt)) {
    const content = fs.readFileSync(paths.keyTxt, "utf8");
    const privMatch = content.match(/PrivateKey:\s*(.*)/);
    const pubMatch = content.match(/PublicKey:\s*(.*)/);
    if (privMatch && pubMatch) {
      privateKey = privMatch[1].trim();
      publicKey = pubMatch[1].trim();
      return;
    }
  }
  const { publicKey: pubKey, privateKey: privKey } = crypto.generateKeyPairSync("x25519");
  privateKey = privKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64url");
  publicKey = pubKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
  fs.writeFileSync(paths.keyTxt, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`, "utf8");
}

const FALLBACK_EC_KEY =
  "-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49\nAwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa\n/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==\n-----END EC PRIVATE KEY-----\n";
const FALLBACK_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw\nEzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy\nMDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH\nA0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h\naD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR\nBfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB\nAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+\neQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==\n-----END CERTIFICATE-----\n";

function ensureTlsCertificates() {
  if (fs.existsSync(paths.cert) && fs.existsSync(paths.key)) return;
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
    const hash = crypto.createHash("sha256").update(Buffer.from(derMatch[1].replace(/\s/g, ""), "base64")).digest("hex");
    return hash.match(/.{2}/g).join(":").toUpperCase();
  } catch (error) {
    return "";
  }
}

// ========================================================
// 3. 配置文件生成 (Xray & Cloudflared)
// ========================================================

function prepareArgoConfig() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) return;
  if (ARGO_AUTH.includes("TunnelSecret")) {
    try {
      const authData = JSON.parse(ARGO_AUTH);
      fs.writeFileSync(paths.tunnelJson, ARGO_AUTH);
      const tunnelYaml = [
        `tunnel: ${authData.TunnelID}`,
        `credentials-file: ${paths.tunnelJson}`,
        `protocol: http2`,
        `ingress:`,
        `  - hostname: ${ARGO_DOMAIN}`,
        `    service: http://localhost:${ARGO_PORT}`,
        `    originRequest:`,
        `      noTLSVerify: true`,
        `      keepAliveConnections: 100`,
        `  - service: http_status:404`,
      ].join("\n");
      fs.writeFileSync(paths.tunnelYml, tunnelYaml);
    } catch (e) {
      console.error("[!] ARGO_AUTH JSON 解析失败:", e.message);
    }
  }
}

function generateXrayConfig() {
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

  if (isValidPort(REALITY_PORT)) {
    config.inbounds.push({
      tag: "vless-reality-in",
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

  if (isValidPort(HY2_PORT)) {
    config.inbounds.push({
      tag: "hysteria2-in",
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

  if (isValidPort(S5_PORT)) {
    config.inbounds.push({
      tag: "socks5-in",
      listen: "::",
      port: parseInt(S5_PORT, 10),
      protocol: "socks",
      settings: { auth: "password", accounts: [{ user: UUID.substring(0, 8), pass: UUID.slice(-12) }], udp: true },
    });
  }

  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2));
}

// ========================================================
// 4. 二进制下载与进程启动
// ========================================================

function getSystemArchitecture() {
  const arch = os.arch();
  return ["arm", "arm64", "aarch64"].includes(arch) ? "arm" : "amd";
}

function downloadFile(fileName, fileUrl) {
  return new Promise((resolve, reject) => {
    const tempFilePath = `${fileName}.download`;
    const writer = fs.createWriteStream(tempFilePath);

    axios({
      method: "get",
      url: fileUrl,
      responseType: "stream",
      timeout: 30000, // 增加 30 秒下载超时防止挂死
    })
      .then((response) => {
        response.data.pipe(writer);
        writer.on("finish", () => {
          writer.close(() => {
            try {
              fs.renameSync(tempFilePath, fileName);
              fs.chmodSync(fileName, 0o775);
              resolve(fileName);
            } catch (err) {
              fs.unlink(tempFilePath, () => {});
              reject(err);
            }
          });
        });
        writer.on("error", (err) => {
          fs.unlink(tempFilePath, () => {});
          reject(err);
        });
      })
      .catch((err) => {
        fs.unlink(tempFilePath, () => {});
        reject(err);
      });
  });
}

async function downloadWithFallback(fileName, urls) {
  for (const url of urls) {
    try {
      return await downloadFile(fileName, url);
    } catch (err) {
      console.log(`[WARN] 下载失败 (${url})，尝试备用源...`);
    }
  }
  throw new Error(`无法下载文件: ${fileName}`);
}

function getArgoArgs() {
  if (/^[A-Za-z0-9=_-]{100,500}$/.test(ARGO_AUTH)) {
    return `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
  } else if (ARGO_AUTH.includes("TunnelSecret")) {
    return `tunnel --edge-ip-version auto --config "${paths.tunnelYml}" run`;
  } else {
    return `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile "${paths.bootLog}" --loglevel info --url http://localhost:${ARGO_PORT}`;
  }
}

async function downloadFilesAndRun() {
  const arch = getSystemArchitecture();
  const baseUrl = arch === "arm" ? "https://arm64.oooen.com" : "https://amd64.oooen.com";
  const backupUrl = arch === "arm" ? "https://arm64.ssss.nyc.mn" : "https://amd64.ssss.nyc.mn";

  const tasks = [
    { fileName: paths.web, urls: [`${baseUrl}/web`, `${backupUrl}/web`] },
    { fileName: paths.bot, urls: [`${baseUrl}/bot`, `${backupUrl}/bot`] },
  ];

  if (NEZHA_SERVER && NEZHA_KEY) {
    if (NEZHA_PORT) {
      tasks.unshift({ fileName: paths.npm, urls: [`${baseUrl}/agent`, `${backupUrl}/agent`] });
    } else {
      tasks.unshift({ fileName: paths.php, urls: [`${baseUrl}/v1`, `${backupUrl}/v1`] });
    }
  }

  await Promise.all(tasks.map((t) => downloadWithFallback(t.fileName, t.urls)));

  // 1. 启动哪吒探针
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
      await exec(`nohup "${paths.php}" -c "${paths.nezhaYaml}" >/dev/null 2>&1 &`).catch(() => {});
      console.log(`${phpName} is running`);
    } else {
      const tlsFlag = ["443", "8443", "2096", "2087", "2083", "2053"].includes(NEZHA_PORT) ? "--tls" : "";
      await exec(
        `nohup "${paths.npm}" -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${tlsFlag} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`
      ).catch(() => {});
      console.log(`${npmName} is running`);
    }
  }

  // 2. 启动 Xray
  await exec(`nohup "${paths.web}" -c "${paths.config}" >/dev/null 2>&1 &`).catch(() => {});
  console.log(`${webName} is running`);

  // 3. 启动 Cloudflared
  if (fs.existsSync(paths.bot)) {
    const args = getArgoArgs();
    await exec(`nohup "${paths.bot}" ${args} >/dev/null 2>&1 &`).catch(() => {});
    console.log(`${botName} is running`);
  }
}

// ========================================================
// 5. 隧道域名提取与差异化节点生成
// ========================================================

async function waitForQuickTunnelLog(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(paths.bootLog)) {
        const content = fs.readFileSync(paths.bootLog, "utf-8");
        const match = content.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
        if (match && match[1]) return match[1];
      }
    } catch (error) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "";
}

async function extractDomains(retryCount = 0) {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    await generateLinks(ARGO_DOMAIN);
    return;
  }

  const quickDomain = await waitForQuickTunnelLog();
  if (quickDomain) {
    await generateLinks(quickDomain);
    return;
  }

  if (retryCount >= 3) {
    console.error("[!] 临时隧道域名获取失败，已达最大重试次数");
    return;
  }

  // 重试拉起临时隧道
  try {
    if (fs.existsSync(paths.bootLog)) fs.unlinkSync(paths.bootLog);
    if (process.platform === "win32") {
      await exec(`taskkill /f /im ${botName}.exe > nul 2>&1`).catch(() => {});
    } else {
      await exec(`pkill -f "[${botName.charAt(0)}]${botName.substring(1)}" > /dev/null 2>&1`).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2000));
    const args = getArgoArgs();
    await exec(`nohup "${paths.bot}" ${args} >/dev/null 2>&1 &`).catch(() => {});
    await extractDomains(retryCount + 1);
  } catch (e) {}
}

// 修复了原代码 timeout 写在 headers 内部的 Bug
async function getMetaInfo() {
  try {
    const res1 = await axios.get("https://api.ip.sb/geoip", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 3500,
    });
    if (res1.data && res1.data.country_code && res1.data.isp) {
      return `${res1.data.country_code}_${res1.data.isp}`.replace(/\s+/g, "_");
    }
  } catch (e) {}

  try {
    const res2 = await axios.get("http://ip-api.com/json", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 3500,
    });
    if (res2.data && res2.data.status === "success" && res2.data.countryCode && res2.data.org) {
      return `${res2.data.countryCode}_${res2.data.org}`.replace(/\s+/g, "_");
    }
  } catch (e) {}

  return "Node";
}

async function getServerIP() {
  const urls = ["http://ipv4.ip.sb", "https://api.ipify.org"];
  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 3000 });
      if (res.data) return res.data.trim();
    } catch (e) {}
  }
  try {
    const ipv6 = (await axios.get("http://ipv6.ip.sb", { timeout: 3000 })).data.trim();
    if (ipv6) return `[${ipv6}]`;
  } catch (e) {}
  return ARGO_DOMAIN || CFIP || "127.0.0.1";
}

async function generateLinks(argoDomain) {
  const ispInfo = await getMetaInfo();
  const SERVER_IP = await getServerIP();
  const prefix = NAME ? NAME : "Node";

  // 生成各协议专属的差异化节点名称，防止客户端混淆或被订阅转换去重
  const nameVlessArgo = `${prefix}-VLESS-Argo-${ispInfo}`;
  const nameVmessArgo = `${prefix}-VMess-Argo-${ispInfo}`;
  const nameTrojanArgo = `${prefix}-Trojan-Argo-${ispInfo}`;
  const nameHy2 = `${prefix}-HY2-直连-${ispInfo}`;
  const nameReality = `${prefix}-Reality-直连-${ispInfo}`;
  const nameSocks5 = `${prefix}-Socks5-${ispInfo}`;

  // 外层已有 Cloudflare TLS，内层 scy 设为 zero 降低 CPU 占用并提升连接稳定性
  const vmessObj = {
    v: "2",
    ps: nameVmessArgo,
    add: CFIP,
    port: CFPORT,
    id: UUID,
    aid: "0",
    scy: "zero",
    net: "ws",
    type: "none",
    host: argoDomain,
    path: "/vmess-argo?ed=2560",
    tls: "tls",
    sni: argoDomain,
    alpn: "",
    fp: "firefox",
  };

  const nodeLinks = [
    `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${encodeURIComponent(nameVlessArgo)}`,
    `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString("base64")}`,
    `trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${encodeURIComponent(nameTrojanArgo)}`,
  ];

  if (isValidPort(HY2_PORT)) {
    const fingerprint = getCertificateFingerprint();
    const fpParam = fingerprint ? `&pinSHA256=${encodeURIComponent(fingerprint)}` : "";
    nodeLinks.push(
      `hysteria2://${UUID}@${SERVER_IP}:${HY2_PORT}/?sni=www.bing.com&insecure=0&alpn=h3&obfs=none${fpParam}#${encodeURIComponent(nameHy2)}`
    );
  }

  if (isValidPort(REALITY_PORT)) {
    nodeLinks.push(
      `vless://${UUID}@${SERVER_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.iij.ad.jp&fp=firefox&pbk=${publicKey}&type=tcp&headerType=none#${encodeURIComponent(nameReality)}`
    );
  }

  if (isValidPort(S5_PORT)) {
    const s5Auth = Buffer.from(`${UUID.substring(0, 8)}:${UUID.slice(-12)}`).toString("base64");
    nodeLinks.push(`socks://${s5Auth}@${SERVER_IP}:${S5_PORT}#${encodeURIComponent(nameSocks5)}`);
  }

  const subTxt = nodeLinks.join("\n");
  subContent = Buffer.from(subTxt).toString("base64");

  fs.writeFileSync(paths.sub, subContent);
  fs.writeFileSync(paths.list, subTxt, "utf8");

  // 保存 Web 订阅访问链接到本地文件
  const webAccessUrl = MY_WEB_DOMAIN
    ? `https://${MY_WEB_DOMAIN}/${SUB_PATH}`
    : PROJECT_URL
    ? `https://${PROJECT_URL}/${SUB_PATH}`
    : `http://${SERVER_IP}:${PORT}/${SUB_PATH}`;

  fs.writeFileSync(paths.webUrl, `Web 订阅服务链接: ${webAccessUrl}\n`, "utf8");
  alwaysLog(`[INFO] Web 链接已保存至: ${paths.webUrl} -> ${webAccessUrl}`);

  await uploadNodes(nodeLinks);
}

async function uploadNodes(nodes) {
  if (!UPLOAD_URL) return;
  if (PROJECT_URL) {
    await axios
      .post(
        `${UPLOAD_URL}/api/add-subscriptions`,
        { subscription: [`${PROJECT_URL}/${SUB_PATH}`] },
        { headers: { "Content-Type": "application/json" }, timeout: 5000 }
      )
      .catch(() => {});
  } else if (nodes && nodes.length > 0) {
    await axios
      .post(
        `${UPLOAD_URL}/api/add-nodes`,
        { nodes },
        { headers: { "Content-Type": "application/json" }, timeout: 5000 }
      )
      .catch(() => {});
  }
}

// ========================================================
// 6. 延迟安全清理与主启动流程
// ========================================================

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
    if (NEZHA_PORT) filesToDelete.push(paths.npm);
    else if (NEZHA_SERVER && NEZHA_KEY) filesToDelete.push(paths.php);

    for (const file of filesToDelete) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (e) {}
    }
    alwaysLog("App is running");
  }, 60000); // 在服务完全就绪后再等待 60 秒执行清理
}

async function startServer() {
  try {
    // 1. 先上报删除旧节点并清理上次残留文件（顺序不可颠倒）
    await deleteOldNodes();
    cleanupOldFiles();

    // 2. 生成证书、密钥与配置文件
    prepareArgoConfig();
    if (isValidPort(REALITY_PORT)) generateOrLoadKeyPair();
    if (isValidPort(HY2_PORT)) ensureTlsCertificates();
    generateXrayConfig();

    // 3. 下载核心组件并启动服务
    await downloadFilesAndRun();

    // 4. 提取域名并生成差异化订阅链接
    await extractDomains();

    // 5. 全部启动完成后再挂载清理定时器
    scheduleCleanFiles();
  } catch (error) {
    console.error("Error in startServer:", error);
  }
}

// ========================================================
// 7. HTTP 订阅与伪装服务器
// ========================================================

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath === `/${SUB_PATH}`) {
    if (subContent) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(subContent);
    } else {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Subscription content not yet available, please try again later.");
    }
    return;
  }

  if (urlPath === "/") {
    try {
      const data = await fs.promises.readFile(path.join(__dirname, "index.html"), "utf8");
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
  startServer();
});