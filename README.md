<div align="center">
  <img src="https://cdn.nodeimage.com/i/NXz3ah3zTwikq3AdQOU0dYw3uyaBiGVj.webp" width="80" height="80" alt="logo"/> 
  <h1>NodeJS Argo 隧道代理工具</h1>
  <p>专为 PaaS 容器化平台与玩具机设计的 Argo 隧道节点部署方案</p>
  
  <a href="https://t.me/eooceu">💬 Telegram 交流反馈群组</a>
</div>

---

## ⚠️ 郑重声明

> **开源协议变更通知**：本项目自 **2025年10月29日 15:45** 起已更改开源协议，并包含以下强制性特定要求：
> 1. **仅限个人使用**：严格禁止用于任何形式的商业行为（包括但不限于 YouTube、Bilibili、TikTok、Facebook 等平台的引流或盈利）。
> 2. **禁止二次商业封装**：禁止新建项目将本代码复制至个人仓库用作商业用途。
> 3. **合规使用**：请严格遵守当地法律法规，禁止滥用本程序搭建公共代理服务。
> 4. **法律责任**：如有违反以上任何条款者，项目方保留追究其法律责任的权利。

---

## 📖 项目简介

`nodejs-argo` 是一个轻量、高效的代理部署工具，特别适用于各类云原生容器环境和免费 PaaS 平台。

### ✨ 核心特性
- **多协议并发**：原生支持 VLESS、VMess、Trojan、Hysteria2、Reality 及 Socks5。
- **探针无缝集成**：内置支持哪吒探针（支持 v0 与 v1 版本），自动识别端口并启用 TLS。
- **隧道灵活配置**：支持 Cloudflare 临时隧道（免配置）与固定隧道（需 Token 或 JSON）双重模式。
- **极简部署**：对于标准 Node.js 环境，仅需上传核心脚本即可一键运行，内置自动保活与防失联机制。

---

## ⚙️ 环境变量配置字典 (Environment Variables)

系统高度可定制，所有参数均为**可选（非必填）**。请根据实际需求在环境或 `.env` 文件中配置。

### 1. 基础系统配置
| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | `3000` | Web 服务对外的 HTTP 监听端口 |
| `FILE_PATH` | `.npm` | 核心文件与配置的运行存放隐藏目录 |
| `SHOW_LOG` | `true` | 是否显示控制台运行日志 (`true`/`yes` 显示，`false`/`no` 屏蔽) |

### 2. 核心节点与伪装配置
| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `UUID` | `9afd1229...` | 节点连接的唯一身份凭证 |
| `SUB_PATH` | `sub` | 订阅链接的路由路径（例如：访问 `/sub` 获取节点） |
| `CFIP` | `saas.sin.fan` | 订阅节点中显示的 CF 优选 IP 或优选 CNAME 域名 |
| `CFPORT` | `443` | 订阅节点中连接的 CF 边缘端口 |
| `NAME` | *(留空)* | 节点名称的前缀标识 |

### 3. Cloudflare Argo 隧道配置
| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `ARGO_DOMAIN` | *(留空)* | 固定隧道的 Public Hostname，**留空则自动启用临时隧道** |
| `ARGO_AUTH` | *(留空)* | CF 隧道的 Token (`eyJh...`) 或 JSON 凭证文件内容，**留空启用临时隧道** |
| `ARGO_PORT` | `8001` | Xray 本地监听端口，用于承接隧道转发的流量 |

### 4. 多协议直连配置 (适用于支持多端口开放的环境)
| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `REALITY_PORT`| *(留空)* | VLESS-Reality 协议的公网直连 TCP 端口 |
| `HY2_PORT` | *(留空)* | Hysteria2 协议的公网直连 UDP 端口 |
| `S5_PORT` | *(留空)* | Socks5 协议的公网直连 TCP 端口。**⚠️ 注意：只能填纯数字端口号（如 `10001`），系统会自动使用 UUID 生成账号密码，切勿填写完整 URL。** |

### 5. 哪吒探针配置 (Nezha Probe)
| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `NEZHA_SERVER` | *(留空)* | 探针服务端地址（v1 填 `域名:端口`，v0 仅填 `域名`） |
| `NEZHA_PORT` | *(留空)* | 探针服务端的 RPC 端口（仅 v0 需要填写，v1 留空） |
| `NEZHA_KEY` | *(留空)* | 探针客户端的安全认证密钥 (Client Secret / Agent Key) |

### 6. 订阅推送与自动化配置
| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MY_WEB_DOMAIN`| *(留空)* | 自定义 Web 订阅域名，填入域名系统会自动拼接 `https://` 并在本地生成记录。 |
| `PROJECT_URL` | *(留空)* | 当前容器的公网 URL，配合 `UPLOAD_URL` 拼接订阅，或配合自动保活使用。 |
| `AUTO_ACCESS` | `false` | **[新增]** 是否开启 Serv00 等平台的自动保活任务（填入 `true` 开启，需配合 `PROJECT_URL` 使用）。 |
| `UPLOAD_URL` | *(留空)* | 第三方订阅面板 API 地址，用于自动上报与分发节点（例如 Merge-sub 地址）。 |
| `CHAT_ID` | *(留空)* | Telegram 接收通知的 Chat ID（留空则禁用 TG 推送）。 |
| `BOT_TOKEN` | *(留空)* | Telegram 机器人的 Token。 |

---

## 🌐 订阅获取方式

节点成功运行后，您可以通过访问以下地址获取订阅内容：
- **云平台访问 (自带 HTTPS)**：`https://你的自定义域名/sub`
- **本地/VPS 直连访问**：`http://你的IP或域名:端口/sub`
*(注：路径后缀由环境变量 `SUB_PATH` 决定，默认已修改为 `/sub`)*

💡 *系统启动后，也会在 `FILE_PATH` 目录下自动生成 `web_url.txt`，方便您随时查看当前的订阅直连地址。*

---

## 🚀 安装与部署

### 1. NPM 全局安装（推荐）

```bash
# 使用 npm 安装
npm install -g nodejs-argo

# 或使用 yarn
yarn global add nodejs-argo

# 或使用 pnpm
pnpm add -g nodejs-argo