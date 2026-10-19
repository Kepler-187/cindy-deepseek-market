# DeepSeek 搜索（Cindy 插件）

把 DeepSeek 自研搜索引擎接进 Cindy，供 **Pi / Claude Code / Codex** 三个 agent 共用。

## 提供的能力

| 工具 | 说明 |
|---|---|
| `deepseek_search` | 网页搜索：标题、链接、长摘要、正文（可选）、相关性与权威性评分；支持 `site:`、`-site:`、`"精确短语"`、`lang:zh,en`、`after:2026-01-01`、`before:` 语法；一次可传 2-4 条 `queries` |
| `deepseek_fetch` | 抓取网页，返回 Markdown 正文；支持 `urls` 并行（最多 5 个） |
| `deepseek_status` | 诊断：API Key 来源、接口连通性 |

## 目录结构

```
deepseek-market/
├── .agents/plugins/marketplace.json   # 插件市场清单（本地源）
└── plugin/
    ├── ghost.json                     # 插件清单（schemaVersion 3）
    ├── main.js                        # 沙箱侧入口，转发工具调用到 worker
    └── node/worker.cjs                # 本地 worker（JSON-RPC over stdio，调 DeepSeek API）
```

## 安装

1. Cindy → 设置 → 插件 → 添加插件市场
   - 来源：`Kepler-187/cindy-deepseek-market`
   - Git 引用：主分支（默认）
   - 稀疏路径：留空
2. 在源里安装「DeepSeek 搜索」，装好后在插件列表可见，可随时启停。
3. 装完新开一个会话，三个 agent 都能用这三个工具。

## 配置 API Key

worker 按以下顺序找 Key，命中第一个就用：

1. 环境变量 `DEEPSEEK_API_KEY`
2. `%USERPROFILE%\.cindy\deepseek-search.json`
3. `%USERPROFILE%\.pi\deepseek-search.json`
4. `$PI_CODING_AGENT_DIR\deepseek-search.json`

配置文件内容：

```json
{ "apiKey": "sk-..." }
```

最快的方式（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$HOME\.cindy" | Out-Null
'{ "apiKey": "sk-你的key" }' | Set-Content -Encoding utf8 "$HOME\.cindy\deepseek-search.json"
```

key 只存在本机，不会进仓库。

## 自检（不经过 Cindy 直接跑 worker）

```powershell
cd plugin
'{"jsonrpc":"2.0","id":1,"method":"deepseek/status","params":{}}' | node node/worker.cjs
```

## 计费

- Search / Fetch 各 **5 元 / 1000 次成功请求**（失败、无结果不计费）
- QPS：每账号 Search、Fetch 各自 5

## 边界

- 工具名是 `deepseek_search` / `deepseek_fetch`，**不替换** Claude Code / Codex 内置的搜索工具；是否优先调用靠 `ghost.json` 的 `whenToUse` 描述引导。
- 若还想让 Pi 的 `web_search` 默认走 DeepSeek，需要额外叠加一个 Pi 扩展（另一套东西，不影响本插件）。
