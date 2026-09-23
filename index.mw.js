#!/usr/bin/env node

const http = require("http");
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');
const { promisify } = require('util');
const { exec: execCommand, execSync } = require('child_process');
const exec = promisify(execCommand);

// ========================================================
// 1. 全局配置与核心环境变量
// ========================================================

// [系统与路由配置]
const FILE_PATH = process.env.FILE_PATH || '.npm';          // 运行目录,sub节点文件保存目录
const SUB_PATH = process.env.SUB_PATH || 'vless';             // 订阅链接的路由路径
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000; // HTTP 服务端口
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913'; // 唯一身份凭证

// [自动化附加功能配置]
const UPLOAD_URL = process.env.UPLOAD_URL || '';            // 节点自动上传地址
const PROJECT_URL = process.env.PROJECT_URL || '';          // 当前容器的公网 URL，配合上传使用
const MY_WEB_DOMAIN = process.env.MY_WEB_DOMAIN || 'vls-wispbyte.wct.kdns.fr';      // 自定义 Web 订阅域名，系统会自动拼接 https:// 和 SUB_PATH

// [Cloudflare Argo 隧道配置]
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || 'wispbyte.wct.kdns.fr';          // 固定隧道域名, 留空即启用临时隧道
const ARGO_AUTH = process.env.ARGO_AUTH || 'eyJhIjoiOGI0YjkxZDNiNWNjZGMzNDEzM2I4MTljOGM1OWRiZGQiLCJ0IjoiOGU5M2YwZjItYjU4YS00M2M2LThkYzAtMGVlZjFlNzE2NmNlIiwicyI6Ik5EZ3hPR0l4WkdZdE1EazBOeTAwTWpBMExUZzJObVF0TkRjMk5tWmtaalJpTmpSbCJ9';              // 隧道 Token 或 JSON 配置
const ARGO_PORT = process.env.ARGO_PORT || 8001;            // 隧道本地监听端口

// [节点伪装与优选配置]
const CFIP = process.env.CFIP || 'cf.saas.sin.fan';            // 优选域名或 IP
const CFPORT = parseInt(process.env.CFPORT || 443, 10);     // 优选端口
const NAME = process.env.NAME || 'vless';                        // 节点名称前缀

// [多协议直连端口]
const S5_PORT = process.env.S5_PORT || '';                  // Socks5 端口 (注意：只能填纯数字端口号，如 10001)
const HY2_PORT = process.env.HY2_PORT || '';                // Hysteria2 端口
const REALITY_PORT = process.env.REALITY_PORT || '';        // VLESS-Reality 端口

// [Nezha (哪吒探针) 配置]
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';        // 探针服务端地址 (v1 填 域名:端口，v0 仅填 域名)
const NEZHA_PORT = process.env.NEZHA_PORT || '';            // 探针 RPC 端口 (v1 留空，v0 需填)
const NEZHA_KEY = process.env.NEZHA_KEY || '';              // 探针密钥

// [日志控制]
const SHOW_LOG = !['false', 'disable', 'no'].includes((process.env.SHOW_LOG || 'true').toLowerCase()); 

if (!SHOW_LOG) {
  console.log = () => {};
  console.error = () => {};
}
function alwaysLog(msg) {
  process.stdout.write(msg + '\n');
}

// ========================================================
// 2. 初始化环境与辅助函数
// ========================================================
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

function isValidPort(port) {
  try {
    if (port === null || port === undefined || port === '') return false;
    if (typeof port === 'string' && port.trim() === '') return false;
    const portNum = parseInt(port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) return false;
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

// 证书与密钥管理
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

// ========================================================
// 3. 核心配置与服务生成
// ========================================================
async function generateConfig() {
  const config = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      { tag: 'vless-fallback-in', port: ARGO_PORT, listen: '::', protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none', fallbacks: [{ dest: 3001 }, { path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
      { tag: 'vless-tcp-in', port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { tag: 'vless-ws-in', port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { tag: 'vmess-ws-in', port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { tag: 'trojan-ws-in', port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "block" }]
  };

  if (isValidPort(REALITY_PORT)) {
    config.inbounds.push({
      tag: "vless-in", listen: "::", port: parseInt(REALITY_PORT), protocol: "vless",
      settings: { clients: [{ id: UUID, flow: "xtls-rprx-vision" }], decryption: "none" },
      streamSettings: { network: "raw", security: "reality", realitySettings: { show: false, dest: "www.iij.ad.jp:443", xver: 0, serverNames: ["www.iij.ad.jp"], privateKey: privateKey, shortIds: [""] } }
    });
  }

  if (isValidPort(HY2_PORT)) {
    config.inbounds.push({
      tag: "hysteria-in", listen: "::", port: parseInt(HY2_PORT), protocol: "hysteria",
      settings: { version: 2, clients: [{ auth: UUID }] },
      streamSettings: { network: "hysteria", hysteriaSettings: { version: 2, masquerade: { type: "proxy", url: "https://bing.com" } }, security: "tls", tlsSettings: { alpn: ["h3"], certificates: [{ certificateFile: certPath, keyFile: keyPath }] } }
    });
  }

  if (isValidPort(S5_PORT)) {
    config.inbounds.push({
      tag: "s5-in", listen: "::", port: parseInt(S5_PORT), protocol: "socks",
      settings: { auth: "password", accounts: [{ user: UUID.substring(0, 8), pass: UUID.slice(-12) }], udp: true }
    });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// 包含最新原版防失联备份下载逻辑
function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

function downloadFile(fileName, fileUrl, callback) {
  const tempFilePath = `${fileName}.download`;
  const writer = fs.createWriteStream(tempFilePath);
  axios({ method: 'get', url: fileUrl, responseType: 'stream' }).then(response => {
    response.data.pipe(writer);
    writer.on('finish', () => { 
      writer.close(() => {
        try { fs.renameSync(tempFilePath, fileName); callback(null, fileName); } 
        catch (err) { fs.unlink(tempFilePath, () => {}); callback(err); }
      });
    });
    writer.on('error', err => { fs.unlink(tempFilePath, () => {}); callback(err); });
  }).catch(err => { fs.unlink(tempFilePath, () => {}); callback(err); });
}

async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const baseUrl = architecture === 'arm' ? 'https://arm64.oooen.com' : 'https://amd64.oooen.com';
  const backupUrl = architecture === 'arm' ? 'https://arm64.ssss.nyc.mn' : 'https://amd64.ssss.nyc.mn';
  
  const filesToDownload = [
    { fileName: webPath, fileUrls: [`${baseUrl}/web`, `${backupUrl}/web`] },
    { fileName: botPath, fileUrls: [`${baseUrl}/bot`, `${backupUrl}/bot`] }
  ];

  if (NEZHA_SERVER && NEZHA_KEY) {
    if (NEZHA_PORT) filesToDownload.unshift({ fileName: npmPath, fileUrls: [`${baseUrl}/agent`, `${backupUrl}/agent`] });
    else filesToDownload.unshift({ fileName: phpPath, fileUrls: [`${baseUrl}/v1`, `${backupUrl}/v1`] });
  }

  const downloadPromises = filesToDownload.map(fileInfo => new Promise((resolve, reject) => {
    const tryDownload = (urlIndex) => {
      downloadFile(fileInfo.fileName, fileInfo.fileUrls[urlIndex], (err, filePath) => {
        if (!err) { resolve(filePath); return; }
        if (urlIndex + 1 < fileInfo.fileUrls.length) { tryDownload(urlIndex + 1); return; }
        reject(err);
      });
    };
    tryDownload(0);
  }));

  try { await Promise.all(downloadPromises); } catch (err) { console.error('Error downloading files:', err); return; }

  const filesToAuthorize = [webPath, botPath];
  if (NEZHA_PORT) filesToAuthorize.push(npmPath);
  else if (NEZHA_SERVER && NEZHA_KEY) filesToAuthorize.push(phpPath);
  filesToAuthorize.forEach(p => { if (fs.existsSync(p)) fs.chmodSync(p, 0o775); });

  // 运行 Nezha
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

  // 运行 X-ray
  try { await exec(`nohup ${webPath} -c ${configPath} >/dev/null 2>&1 &`); console.log(`${webName} is running`); } catch (error) {}

  // 运行 Cloudflared
  if (fs.existsSync(botPath)) {
    let args;
    if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
      args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
    } else if (ARGO_AUTH.match(/TunnelSecret/)) {
      args = `tunnel --edge-ip-version auto --config "${path.resolve(FILE_PATH, 'tunnel.yml')}" run`;
    } else {
      args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile "${path.resolve(bootLogPath)}" --loglevel info --url http://localhost:${ARGO_PORT}`;
    }
    try { await exec(`nohup "${path.resolve(botPath)}" ${args} >/dev/null 2>&1 &`); console.log(`${botName} is running`); } catch (error) {}
  }
}

// 隧道与链接处理
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

async function waitForQuickTunnelLog(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(bootLogPath)) {
        const content = fs.readFileSync(bootLogPath, 'utf-8');
        if (/trycloudflare\.com/.test(content)) return content;
      }
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return '';
}

async function extractDomains() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    await generateLinks(ARGO_DOMAIN);
  } else {
    try {
      const fileContent = await waitForQuickTunnelLog();
      const lines = fileContent.split('\n');
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
        const args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile "${path.resolve(bootLogPath)}" --loglevel info --url http://localhost:${ARGO_PORT}`;
        try {
          await exec(`nohup "${path.resolve(botPath)}" ${args} >/dev/null 2>&1 &`);
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
  try { return `[${execSync('curl -sm 3 ipv6.ip.sb').toString().trim()}]`; } catch (e) {}
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
      
      // ==========================================
      // 保留用户优化：将 Web 服务的访问连接写入到本地文件中
      // ==========================================
      const webAccessUrl = MY_WEB_DOMAIN ? `https://${MY_WEB_DOMAIN}/${SUB_PATH}` : (PROJECT_URL ? `https://${PROJECT_URL}/${SUB_PATH}` : `http://${SERVER_IP}:${PORT}/${SUB_PATH}`);
      const urlFilePath = path.join(FILE_PATH, 'web_url.txt');
      fs.writeFileSync(urlFilePath, `Web 订阅服务链接: ${webAccessUrl}\n`, 'utf8');
      alwaysLog(`[INFO] Web 链接已保存至: ${urlFilePath} -> ${webAccessUrl}`);
      // ==========================================
      
      uploadNodes();
      resolve(subTxt);
    }, 2000);
  });
}

async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    try { await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, { subscription: [`${PROJECT_URL}/${SUB_PATH}`] }, { headers: { 'Content-Type': 'application/json' } }); } catch (error) {}
  } else if (UPLOAD_URL) {
    if (!fs.existsSync(listPath)) return;
    const nodes = fs.readFileSync(listPath, 'utf-8').split('\n').filter(line => /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line));
    if (nodes.length === 0) return;
    try { await axios.post(`${UPLOAD_URL}/api/add-nodes`, JSON.stringify({ nodes }), { headers: { 'Content-Type': 'application/json' } }); } catch (error) {}
  }
}

// ========================================================
// 4. 定时清理
// ========================================================

// 融合：保持用户的“静默体验”，但恢复关键文件的清理保障安全
function cleanFiles() {
  setTimeout(() => {
    const filesToDelete = [bootLogPath, configPath, webPath, botPath, listPath, certPath, keyPath];
    if (NEZHA_PORT) filesToDelete.push(npmPath);
    else if (NEZHA_SERVER && NEZHA_KEY) filesToDelete.push(phpPath);

    const rmCmd = process.platform === 'win32' 
        ? `del /f /q ${filesToDelete.join(' ')} > nul 2>&1` 
        : `rm -rf ${filesToDelete.join(' ')} >/dev/null 2>&1`;
    exec(rmCmd).catch(() => {}).finally(() => {
      alwaysLog('App is running'); 
    });
  }, 90000);
}
cleanFiles();

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
  } catch (error) { console.error('Error in startserver:', error); }
}
startserver();

// ========================================================
// 5. HTTP 服务器
// ========================================================
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
      res.end(`Hello world!<br><br>You can access /${SUB_PATH} to get your nodes!`);
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => alwaysLog(`http server is running on ${PORT}!`));