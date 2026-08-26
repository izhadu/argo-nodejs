#!/usr/bin/env node

const http = require("http");
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { execSync } = require('child_process');

// ========================================================
// 1. 全局配置与核心环境变量
// ========================================================

// [系统与路由配置]
const FILE_PATH = process.env.FILE_PATH || '.tmp';          // 核心文件与配置的运行存放目录 (默认隐藏目录防扫描)
const SUB_PATH = process.env.SUB_PATH || 'vless';             // 订阅链接的路由路径 (例如: http://IP:PORT/sub)
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000; // Web 服务器对外的 HTTP 监听端口
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913'; // 节点连接的唯一身份凭证 

// [Cloudflare Argo 隧道配置]
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || 'dcdeploy-zhadukan.clo.ccwu.cc';          // CF 固定的 Public Hostname 域名 (留空则使用 TryCloudflare 临时隧道)
const ARGO_AUTH = process.env.ARGO_AUTH || 'eyJhIjoiOGI0YjkxZDNiNWNjZGMzNDEzM2I4MTljOGM1OWRiZGQiLCJ0IjoiZWE1ODllMTktYzFjOC00YzUxLWJmNjgtODA5MWU0ZTNkZDZiIiwicyI6Ik5HTXdObU16TVdVdE16ZzJaUzAwWlRJNUxUZzRZekF0T0dFM01qa3lObVV3WmpCaCJ9';              // CF 隧道的 Token (eyJh...) 或 TunnelSecret JSON 配置
const ARGO_PORT = process.env.ARGO_PORT || 8001;            // Xray 本地监听端口，承接 Argo 隧道转发的流量

// [节点伪装与优选配置]
const CFIP = process.env.CFIP || 'cf.saas.zhadu.com';            // 订阅节点中显示的 CF 优选 IP 或优选 CNAME 域名
const CFPORT = parseInt(process.env.CFPORT || 443, 10);     // 订阅节点中连接的 CF 边缘端口
const NAME = process.env.NAME || 'vls';           // 节点名称前缀

// [多协议直连端口 (适用于支持多端口开放的环境)]
const S5_PORT = process.env.S5_PORT || 'socks5://zhadukan:asp789.coM@163.192.61.84:10001';                  // Socks5 协议的公网直连 TCP 端口
const HY2_PORT = process.env.HY2_PORT || '';                // Hysteria2 协议的公网直连 UDP 端口
const REALITY_PORT = process.env.REALITY_PORT || '';        // VLESS-Reality 协议的公网直连 TCP 端口

// [Nezha (哪吒探针) 配置]
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';        // 探针服务端地址 (v1 填 "域名:端口"，v0 仅填 "域名")
const NEZHA_PORT = process.env.NEZHA_PORT || '';            // 探针服务端的 RPC 端口 (仅 v0 需要填写，v1 留空)
const NEZHA_KEY = process.env.NEZHA_KEY || '';              // 探针客户端的安全认证密钥 (Client Secret)

// [自动化附加功能配置]
const UPLOAD_URL = process.env.UPLOAD_URL || '';            // 第三方订阅面板 API 地址，用于自动上传节点
const PROJECT_URL = process.env.PROJECT_URL || '';          // 当前容器的公网 URL，配合 UPLOAD_URL 使用
const CHAT_ID = process.env.CHAT_ID || '';                  // Telegram 接收通知的 Chat ID (留空禁用 TG 推送)
const BOT_TOKEN = process.env.BOT_TOKEN || '';              // Telegram 机器人的 Token

// [日志控制]
const SHOW_LOG = !['false', 'disable', 'no'].includes((process.env.SHOW_LOG || 'no').toLowerCase()); 

// ========================================================
// 控制日志输出 (全局静默拦截)
// ========================================================
if (!SHOW_LOG) {
  console.log = () => {};
  console.error = () => {};
}
function alwaysLog(msg) {
  process.stdout.write(msg + '\n');
}

// 初始化运行环境
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

function isValidPort(port) {
  try {
    if (port === null || port === undefined || port === '') return false;
    if (typeof port === 'string' && port.trim() === '') return false;
    const portNum = parseInt(port);
    if (isNaN(portNum)) return false;
    if (portNum < 1 || portNum > 65535) return false;
    return true;
  } catch (error) { return false; }
}

function generateRandomName() {
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

let subContent = null;
let privateKey = '', publicKey = '';
const npmName = generateRandomName(), webName = generateRandomName(), botName = generateRandomName(), phpName = generateRandomName();
let npmPath = path.join(FILE_PATH, npmName), phpPath = path.join(FILE_PATH, phpName), webPath = path.join(FILE_PATH, webName), botPath = path.join(FILE_PATH, botName);
let subPath = path.join(FILE_PATH, 'sub.txt'), listPath = path.join(FILE_PATH, 'list.txt'), bootLogPath = path.join(FILE_PATH, 'boot.log'), configPath = path.join(FILE_PATH, 'config.json');
let certPath = path.resolve(FILE_PATH, 'cert.pem'), keyPath = path.resolve(FILE_PATH, 'private.key');

function deleteNodes() {
  if (!UPLOAD_URL || !fs.existsSync(subPath)) return;
  try {
    const fileContent = fs.readFileSync(subPath, 'utf-8');
    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
    const nodes = decoded.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line));
    if (nodes.length === 0) return;
    axios.post(`${UPLOAD_URL}/api/delete-nodes`, JSON.stringify({ nodes }), { headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  } catch (err) {}
}

function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(FILE_PATH);
    files.forEach(file => {
      const filePath = path.join(FILE_PATH, file);
      try { if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath); } catch (err) {}
    });
  } catch (err) {}
}

function generateOrLoadKeyPair() {
  const keyFilePath = path.join(FILE_PATH, 'key.txt');
  if (fs.existsSync(keyFilePath)) {
    const content = fs.readFileSync(keyFilePath, 'utf8');
    const privateKeyMatch = content.match(/PrivateKey:\s*(.*)/), publicKeyMatch = content.match(/PublicKey:\s*(.*)/);
    if (privateKeyMatch && publicKeyMatch) {
      privateKey = privateKeyMatch[1].trim(); publicKey = publicKeyMatch[1].trim(); return;
    }
  }
  const { publicKey: pubKey, privateKey: privKey } = crypto.generateKeyPairSync('x25519');
  privateKey = privKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url');
  publicKey = pubKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
  fs.writeFileSync(keyFilePath, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`, 'utf8');
}

const FALLBACK_EC_KEY = '-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49\nAwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa\n/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==\n-----END EC PRIVATE KEY-----\n';
const FALLBACK_CERT = '-----BEGIN CERTIFICATE-----\nMIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw\nEzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy\nMDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH\nA0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h\naD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR\nBfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB\nAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+\neQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==\n-----END CERTIFICATE-----\n';

function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  try {
    execSync('openssl version', { stdio: 'ignore' });
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
    return;
  } catch (e) { }
  fs.writeFileSync(keyPath, FALLBACK_EC_KEY);
  fs.writeFileSync(certPath, FALLBACK_CERT);
}

function getCertificateFingerprint(certPath) {
  try {
    const result = execSync(`openssl x509 -noout -fingerprint -sha256 -in "${certPath}"`, { encoding: 'utf8', timeout: 3000 }).trim();
    const match = result.match(/=(.+)$/);
    if (match && match[1]) return match[1].toUpperCase();
  } catch (e) {}
  try {
    const certData = fs.readFileSync(certPath, 'utf8');
    const derMatch = certData.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
    if (!derMatch) return '';
    const hash = crypto.createHash('sha256').update(Buffer.from(derMatch[1].replace(/\s/g, ''), 'base64')).digest('hex');
    return hash.match(/.{2}/g).join(':').toUpperCase();
  } catch (error) { return ''; }
}

async function generateConfig() {
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'vless-fallback-in', port: ARGO_PORT, listen: '127.0.0.1', protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none', fallbacks: [{ dest: 3001 }, { path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
      { tag: 'vless-tcp-in', port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { tag: 'vless-ws-in', port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { tag: 'vmess-ws-in', port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { tag: 'trojan-ws-in', port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [{ protocol: "freedom", tag: "direct", settings: { domainStrategy: "UseIPv4" } }, { protocol: "blackhole", tag: "block" }]
  };

  if (isValidPort(REALITY_PORT)) {
    config.inbounds.push({
      tag: "vless-in", listen: "0.0.0.0", port: parseInt(REALITY_PORT), protocol: "vless",
      settings: { clients: [{ id: UUID, flow: "xtls-rprx-vision" }], decryption: "none" },
      streamSettings: { network: "raw", security: "reality", realitySettings: { show: false, dest: "www.iij.ad.jp:443", xver: 0, serverNames: ["www.iij.ad.jp"], privateKey: privateKey, shortIds: [""] } }
    });
  }

  if (isValidPort(HY2_PORT)) {
    config.inbounds.push({
      tag: "hysteria-in", listen: "0.0.0.0", port: parseInt(HY2_PORT), protocol: "hysteria",
      settings: { version: 2, clients: [{ auth: UUID }] },
      streamSettings: { network: "hysteria", hysteriaSettings: { version: 2, masquerade: { type: "proxy", url: "https://bing.com" } }, security: "tls", tlsSettings: { alpn: ["h3"], certificates: [{ certificateFile: certPath, keyFile: keyPath }] } }
    });
  }

  if (isValidPort(S5_PORT)) {
    config.inbounds.push({
      tag: "s5-in", listen: "0.0.0.0", port: parseInt(S5_PORT), protocol: "socks",
      settings: { auth: "password", accounts: [{ user: UUID.substring(0, 8), pass: UUID.slice(-12) }], udp: true }
    });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

function downloadFile(fileName, fileUrl, callback) {
  const writer = fs.createWriteStream(fileName);
  axios({ method: 'get', url: fileUrl, responseType: 'stream' }).then(response => {
    response.data.pipe(writer);
    writer.on('finish', () => { writer.close(); callback(null, fileName); });
    writer.on('error', err => { fs.unlink(fileName, () => {}); callback(`Failed: ${err.message}`); });
  }).catch(err => callback(`Failed: ${err.message}`));
}

async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const xrayArch = architecture === 'arm' ? 'arm64-v8a' : '64';
  const cfArch = architecture === 'arm' ? 'arm64' : 'amd64';
  
  if (!fs.existsSync(webPath)) {
    try { execSync(`curl -L -s "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${xrayArch}.zip" -o ${FILE_PATH}/x.zip && unzip -q -o ${FILE_PATH}/x.zip xray -d ${FILE_PATH} && mv ${FILE_PATH}/xray ${webPath} && rm -f ${FILE_PATH}/x.zip`); } catch (e) {}
  }
  if (!fs.existsSync(botPath)) {
    try { execSync(`curl -L -s "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}" -o ${botPath}`); } catch (e) {}
  }

  let baseFiles = [];
  if (NEZHA_SERVER && NEZHA_KEY) {
    baseFiles.unshift(NEZHA_PORT 
      ? { fileName: npmPath, fileUrl: `https://${architecture}64.ssss.nyc.mn/agent` } 
      : { fileName: phpPath, fileUrl: `https://${architecture}64.ssss.nyc.mn/v1` });
  }

  if (baseFiles.length > 0) {
    await Promise.all(baseFiles.map(fileInfo => new Promise((resolve, reject) => {
      downloadFile(fileInfo.fileName, fileInfo.fileUrl, (err, filePath) => err ? reject(err) : resolve(filePath));
    }))).catch(() => {});
  }

  const filesToAuthorize = [webPath, botPath];
  if (NEZHA_PORT) filesToAuthorize.push(npmPath);
  else if (NEZHA_SERVER && NEZHA_KEY) filesToAuthorize.push(phpPath);
  filesToAuthorize.forEach(p => { if (fs.existsSync(p)) fs.chmodSync(p, 0o775); });

  if (NEZHA_SERVER && NEZHA_KEY) {
    if (!NEZHA_PORT) {
      const port = NEZHA_SERVER.includes(':') ? NEZHA_SERVER.split(':').pop() : '';
      const nezhatls = new Set(['443', '8443', '2096', '2087', '2083', '2053']).has(port) ? 'true' : 'false';
      const configYaml = `client_secret: ${NEZHA_KEY}\ndebug: false\ndisable_auto_update: true\ndisable_command_execute: false\ndisable_force_update: true\ndisable_nat: false\ndisable_send_query: false\ngpu: false\ninsecure_tls: true\nip_report_period: 1800\nreport_delay: 4\nserver: ${NEZHA_SERVER}\nskip_connection_count: true\nskip_procs_count: true\ntemperature: false\ntls: ${nezhatls}\nuse_gitee_to_upgrade: false\nuse_ipv6_country_code: false\nuuid: ${UUID}`;
      fs.writeFileSync(path.join(FILE_PATH, 'config.yaml'), configYaml);
      try { await exec(`nohup ${phpPath} -c "${FILE_PATH}/config.yaml" >/dev/null 2>&1 &`); console.log(`${phpName} is running`); } catch (error) {}
    } else {
      let NEZHA_TLS = ['443', '8443', '2096', '2087', '2083', '2053'].includes(NEZHA_PORT) ? '--tls' : '';
      try { await exec(`nohup ${npmPath} -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`); console.log(`${npmName} is running`); } catch (error) {}
    }
  }

  try { await exec(`nohup ${webPath} -c ${configPath} >/dev/null 2>&1 &`); console.log(`${webName} is running`); } catch (error) {}

  if (fs.existsSync(botPath)) {
    let args;
    if (ARGO_AUTH && ARGO_AUTH.length > 30 && !ARGO_AUTH.includes('TunnelSecret')) {
      args = `tunnel --edge-ip-version 4 --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
    } else if (ARGO_AUTH.includes('TunnelSecret')) {
      args = `tunnel --edge-ip-version 4 --config ${FILE_PATH}/tunnel.yml run`;
    } else {
      args = `tunnel --edge-ip-version 4 --no-autoupdate --protocol http2 --logfile ${bootLogPath} --loglevel info --url http://localhost:${ARGO_PORT}`;
    }
    try { await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`); console.log(`${botName} is running`); } catch (error) {}
  }
}

function argoType() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) return;
  if (ARGO_AUTH.includes('TunnelSecret')) {
    try {
      const authData = JSON.parse(ARGO_AUTH);
      fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
      const tunnelYaml = `\n tunnel: ${authData.TunnelID}\n credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}\n protocol: http2\n \n ingress:\n   - hostname: ${ARGO_DOMAIN}\n     service: http://localhost:${ARGO_PORT}\n     originRequest:\n       noTLSVerify: true\n   - service: http_status:404\n `;
      fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
    } catch (e) {
      console.error("[!] ARGO_AUTH JSON 解析失败");
    }
  }
}

async function extractDomains() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    await generateLinks(ARGO_DOMAIN);
  } else {
    try {
      const lines = fs.readFileSync(bootLogPath, 'utf-8').split('\n');
      const argoDomains = lines.map(l => l.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/)).filter(m => m).map(m => m[1]);
      if (argoDomains.length > 0) {
        await generateLinks(argoDomains[0]);
      } else {
        fs.unlinkSync(bootLogPath);
        try {
          if (process.platform === 'win32') await exec(`taskkill /f /im ${botName}.exe > nul 2>&1`);
          else await exec(`pkill -f "[${botName.charAt(0)}]${botName.substring(1)}" > /dev/null 2>&1`);
        } catch (e) {}
        await new Promise(r => setTimeout(r, 3000));
        const args = `tunnel --edge-ip-version 4 --no-autoupdate --protocol http2 --logfile ${bootLogPath} --loglevel info --url http://localhost:${ARGO_PORT}`;
        try {
          await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
          await new Promise(r => setTimeout(r, 6000));
          await extractDomains();
        } catch (e) {}
      }
    } catch (e) {}
  }
}

async function getMetaInfo() {
  try {
    const res1 = await axios.get('https://api.ip.sb/geoip', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
    if (res1.data && res1.data.country_code && res1.data.isp) return `${res1.data.country_code}-${res1.data.isp}`.replace(/\s+/g, '_');
  } catch (e) {
    try {
      const res2 = await axios.get('http://ip-api.com/json', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
      if (res2.data && res2.data.status === 'success' && res2.data.countryCode && res2.data.org) return `${res2.data.countryCode}-${res2.data.org}`.replace(/\s+/g, '_');
    } catch (e) {}
  }
  return 'Unknown';
}

async function getServerIP() {
  try { return (await axios.get('http://ipv4.ip.sb', { timeout: 3000 })).data.trim(); } catch (e) {}
  try { return execSync('curl -sm 3 ipv4.ip.sb').toString().trim(); } catch (e) {}
  try { return `[${(await axios.get('http://ipv6.ip.sb', { timeout: 3000 })).data.trim()}]`; } catch (e) {}
  return ARGO_DOMAIN || CFIP || '127.0.0.1';
}

async function generateLinks(argoDomain) {
  const ISP = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
  const SERVER_IP = await getServerIP();

  return new Promise(resolve => {
    setTimeout(() => {
      const VMESS = { v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox' };
      let subTxt = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}\n\nvmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}\n\ntrojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}\n    `;

      if (isValidPort(HY2_PORT)) {
        const fingerprint = getCertificateFingerprint(certPath);
        const fingerprintParam = fingerprint ? `&pinSHA256=${encodeURIComponent(fingerprint)}` : '';
        subTxt += `\nhysteria2://${UUID}@${SERVER_IP}:${HY2_PORT}/?sni=www.bing.com&insecure=0&alpn=h3&obfs=none${fingerprintParam}#${nodeName}`;
      }
      if (isValidPort(REALITY_PORT)) {
        subTxt += `\nvless://${UUID}@${SERVER_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.iij.ad.jp&fp=firefox&pbk=${publicKey}&type=tcp&headerType=none#${nodeName}`;
      }
      if (isValidPort(S5_PORT)) {
        const S5_AUTH = Buffer.from(`${UUID.substring(0, 8)}:${UUID.slice(-12)}`).toString('base64');
        subTxt += `\nsocks://${S5_AUTH}@${SERVER_IP}:${S5_PORT}#${nodeName}`;
      }

      fs.writeFileSync(subPath, Buffer.from(subTxt).toString('base64'));
      fs.writeFileSync(listPath, subTxt, 'utf8');
      subContent = Buffer.from(subTxt).toString('base64');
      uploadNodes();
      resolve(subTxt);
    }, 2000);
  });
}

async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    try {
      await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, { subscription: [`${PROJECT_URL}/${SUB_PATH}`] }, { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {}
  } else if (UPLOAD_URL) {
    if (!fs.existsSync(listPath)) return;
    const nodes = fs.readFileSync(listPath, 'utf-8').split('\n').filter(line => /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line));
    if (nodes.length === 0) return;
    try { await axios.post(`${UPLOAD_URL}/api/add-nodes`, JSON.stringify({ nodes }), { headers: { 'Content-Type': 'application/json' } }); } catch (error) {}
  }
}

// 静默运行，移除清屏操作
function cleanFiles() {
  setTimeout(() => {}, 90000);
}
cleanFiles();

async function sendTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const message = fs.readFileSync(subPath, 'utf8');
    const escapedName = NAME.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, null, { params: { chat_id: CHAT_ID, text: `**${escapedName}节点推送**\n\`\`\`${message}\`\`\``, parse_mode: 'MarkdownV2' } });
  } catch (error) {}
}

async function startserver() {
  try {
    argoType();
    deleteNodes();
    cleanupOldFiles();
    if (isValidPort(REALITY_PORT)) generateOrLoadKeyPair();
    if (isValidPort(HY2_PORT)) ensureTlsCertificates(certPath, keyPath);
    await generateConfig();
    await downloadFilesAndRun();
    await extractDomains();
    await sendTelegram();
    alwaysLog('App is running');
  } catch (error) { console.error('Error in startserver:', error); }
}
startserver();

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === `/${SUB_PATH}`) {
    if (subContent) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(subContent); } 
    else { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Subscription content not yet available, please try again later.'); }
    return;
  }
  if (urlPath === '/') {
    try {
      const data = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end("Hello world!<br><br>You can access /{SUB_PATH}(Default: /sub) to get your nodes!");
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => alwaysLog(`http server is running on ${PORT}!`));
