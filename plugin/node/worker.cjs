'use strict';

/**
 * DeepSeek 搜索插件本地 worker。
 * 协议：JSON-RPC 2.0 over stdio（每行一个 JSON 对象）。
 * 方法：deepseek/search、deepseek/fetch、deepseek/status
 *
 * API Key 解析顺序：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. ~/.cindy/deepseek-search.json
 *   3. ~/.pi/deepseek-search.json
 *   4. $PI_CODING_AGENT_DIR/deepseek-search.json
 * 配置文件格式：{ "apiKey": "sk-..." }
 */

const readline = require('node:readline');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = 'api.deepseek.com';
const SEARCH_PATH = '/v1/tools/search';
const FETCH_PATH = '/v1/tools/fetch';
const REQUEST_TIMEOUT_MS = 45000;
const MAX_CONTENT_PER_RESULT = 6000;
const MAX_TOTAL_CHARS = 60000;

const reply = (value) => process.stdout.write(JSON.stringify(value) + '\n');

// ---------------------------------------------------------------- 配置

function configCandidates() {
  const candidates = [];
  const agentDir = (process.env.PI_CODING_AGENT_DIR || '').trim();
  if (agentDir) candidates.push(path.join(agentDir, 'deepseek-search.json'));
  candidates.push(path.join(os.homedir(), '.cindy', 'deepseek-search.json'));
  candidates.push(path.join(os.homedir(), '.pi', 'deepseek-search.json'));
  return candidates;
}

function resolveApiKey() {
  const fromEnv = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env:DEEPSEEK_API_KEY' };
  for (const candidate of configCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) {
        return { key: parsed.apiKey.trim(), source: candidate };
      }
    } catch {
      /* 文件不存在或格式无效时继续尝试下一个 */
    }
  }
  return { key: null, source: null };
}

// ---------------------------------------------------------------- HTTP

function describeHttpError(status, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    const message = parsed && parsed.error && parsed.error.message;
    if (typeof message === 'string' && message.trim()) detail = '：' + message.trim().slice(0, 300);
  } catch {
    const trimmed = String(body || '').trim();
    if (trimmed) detail = '：' + trimmed.slice(0, 300);
  }

  if (status === 400) return 'DeepSeek 请求参数不合法（HTTP 400）' + detail;
  if (status === 401) return 'DeepSeek API Key 缺失或无效（HTTP 401）' + detail + '。请设置环境变量 DEEPSEEK_API_KEY 或写入 ~/.cindy/deepseek-search.json。';
  if (status === 402) return 'DeepSeek 账户余额不足（HTTP 402）' + detail + '，充值后重试。';
  if (status === 403) return 'DeepSeek 拒绝了该请求（HTTP 403）' + detail;
  if (status === 404) return 'DeepSeek 未能获取可用内容（HTTP 404）' + detail + '。URL 可能不可达、被站点策略拦截，或页面没有可提取正文。';
  if (status === 408) return 'DeepSeek 读取超时（HTTP 408）' + detail + '，可重试。';
  if (status === 413) return '请求体超过 DeepSeek 限制（HTTP 413）' + detail;
  if (status === 429) return 'DeepSeek 限速（HTTP 429，每账号 Search/Fetch 各 5 QPS）' + detail;
  if (status >= 500) return 'DeepSeek 服务端错误（HTTP ' + status + '）' + detail + '，可稍后重试。';
  return 'DeepSeek 请求失败（HTTP ' + status + '）' + detail;
}

function postJson(urlPath, body, key) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = https.request(
      {
        host: HOST,
        path: urlPath,
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 24 * 1024 * 1024) {
            request.destroy(new Error('DeepSeek 响应过大，已中止'));
          }
        });
        response.on('end', () => {
          const status = response.statusCode || 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch {
              reject(new Error('DeepSeek 返回了非 JSON 响应（HTTP ' + status + '）'));
            }
            return;
          }
          const error = new Error(describeHttpError(status, raw));
          error.status = status;
          reject(error);
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error('DeepSeek 请求超时（' + REQUEST_TIMEOUT_MS + 'ms）')));
    request.on('error', (error) => reject(error));
    request.write(payload);
    request.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postJsonWithRetry(urlPath, body, key) {
  try {
    return await postJson(urlPath, body, key);
  } catch (error) {
    if (error && error.status === 429) {
      await sleep(1500);
      return await postJson(urlPath, body, key);
    }
    throw error;
  }
}

// ---------------------------------------------------------------- 查询构造

function normalizeDomain(raw) {
  let value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('-')) value = value.slice(1).trim();
  if (!value) return null;
  try {
    const withScheme = value.includes('://') ? value : 'https://' + value;
    value = new URL(withScheme).hostname;
  } catch {
    value = (value.split('/')[0] || '').split(':')[0];
  }
  value = value.replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value) ? value : null;
}

function recencyToAfter(filter) {
  const days = filter === 'day' ? 1 : filter === 'week' ? 7 : filter === 'month' ? 30 : filter === 'year' ? 365 : null;
  if (days === null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildQuery(query, domainFilter, recencyFilter) {
  const parts = [String(query).trim()];
  const allowed = [];
  const blocked = [];

  if (Array.isArray(domainFilter)) {
    for (const entry of domainFilter) {
      if (typeof entry !== 'string') continue;
      const domain = normalizeDomain(entry);
      if (!domain) continue;
      const target = entry.trim().startsWith('-') ? blocked : allowed;
      if (target.indexOf(domain) === -1) target.push(domain);
    }
  }

  if (allowed.length === 1) parts.push('site:' + allowed[0]);
  else if (allowed.length > 1) parts.push(allowed.map((domain) => 'site:' + domain).join(' OR '));
  for (const domain of blocked) parts.push('-site:' + domain);

  const after = recencyToAfter(recencyFilter);
  if (after) parts.push('after:' + after);

  return parts.join(' ');
}

function normalizeQueries(params) {
  const list = Array.isArray(params.queries) ? params.queries : params.query !== undefined ? [params.query] : [];
  const seen = [];
  const queries = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.indexOf(trimmed) !== -1) continue;
    seen.push(trimmed);
    queries.push(trimmed);
  }
  return queries.slice(0, 4);
}

function normalizeCount(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.floor(value), 20));
}

// ---------------------------------------------------------------- 输出

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…（已截断，原长 ' + text.length + ' 字符）';
}

function formatMeta(result) {
  const bits = [];
  if (typeof result.rerank_score === 'number') bits.push('相关性 ' + result.rerank_score.toFixed(2));
  if (typeof result.authority === 'number' && result.authority >= 0) bits.push('权威 ' + result.authority);
  if (typeof result.date === 'string' && result.date.length >= 10) bits.push(result.date.slice(0, 10));
  if (result.site_name) bits.push(String(result.site_name));
  return bits.join(' · ');
}

function formatResults(query, results, includeContent) {
  if (results.length === 0) return 'DeepSeek 搜索「' + query + '」没有返回结果。';

  const lines = ['DeepSeek 搜索「' + query + '」：' + results.length + ' 条结果'];
  results.forEach((result, index) => {
    const title = result.title || result.url || '(无标题)';
    const meta = formatMeta(result);
    const summary = String(result.summary || result.snippet || '').trim();
    lines.push('');
    lines.push(index + 1 + '. ' + title);
    if (result.url) lines.push('   ' + result.url);
    if (meta) lines.push('   ' + meta);
    if (summary) lines.push('   ' + summary);
    if (includeContent && result.content) {
      lines.push('   正文：');
      lines.push(truncate(String(result.content).trim(), MAX_CONTENT_PER_RESULT));
    }
  });
  return truncate(lines.join('\n'), MAX_TOTAL_CHARS);
}

// ---------------------------------------------------------------- 业务

function missingKeyResult() {
  return {
    ok: false,
    errorCode: 'MISSING_API_KEY',
    message:
      '缺少 DeepSeek API Key。设置环境变量 DEEPSEEK_API_KEY，或把 {"apiKey":"sk-..."} 写入 ' +
      path.join(os.homedir(), '.cindy', 'deepseek-search.json') +
      ' 后重试。',
  };
}

async function executeSearch(params) {
  const resolved = resolveApiKey();
  if (!resolved.key) return missingKeyResult();

  const queries = normalizeQueries(params || {});
  if (queries.length === 0) {
    return { ok: false, errorCode: 'NO_QUERY', message: '没有提供查询词，请使用 query 或 queries 参数。' };
  }

  const count = normalizeCount(params.numResults);
  const includeContent = params.includeContent === true;
  const blocks = [];
  const collected = [];

  try {
    for (const query of queries) {
      const built = buildQuery(query, params.domainFilter, params.recencyFilter);
      const payload = await postJsonWithRetry(
        SEARCH_PATH,
        { query: built, count: count, need_content: includeContent },
        resolved.key
      );
      const results = Array.isArray(payload.results) ? payload.results : [];
      collected.push({ query: query, built: built, results: results });
      blocks.push(formatResults(query, results, includeContent));
    }
  } catch (error) {
    return {
      ok: false,
      errorCode: 'SEARCH_FAILED',
      message: error && error.message ? error.message : String(error),
    };
  }

  return {
    ok: true,
    text: blocks.join('\n\n'),
    results: collected,
    meta: {
      engine: 'deepseek',
      count: count,
      includeContent: includeContent,
      queries: queries,
      keySource: resolved.source,
    },
  };
}

async function executeFetch(params) {
  const resolved = resolveApiKey();
  if (!resolved.key) return missingKeyResult();

  const rawList = Array.isArray(params.urls) ? params.urls : params.url !== undefined ? [params.url] : [];
  const urls = [];
  for (const entry of rawList) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed) urls.push(trimmed);
  }
  if (urls.length === 0) {
    return { ok: false, errorCode: 'NO_URL', message: '没有提供 URL，请使用 url 或 urls 参数。' };
  }

  const targets = urls.slice(0, 5);
  const settled = await Promise.all(
    targets.map(async (url) => {
      try {
        const payload = await postJsonWithRetry(FETCH_PATH, { url: url }, resolved.key);
        return {
          ok: true,
          url: url,
          title: typeof payload.title === 'string' ? payload.title : '',
          content: typeof payload.content === 'string' ? payload.content : '',
        };
      } catch (error) {
        return { ok: false, url: url, message: error && error.message ? error.message : String(error) };
      }
    })
  );

  const budget = Math.max(4000, Math.floor(MAX_TOTAL_CHARS / Math.max(1, settled.length)));
  const blocks = [];
  const fetched = [];

  for (const item of settled) {
    if (!item.ok) {
      blocks.push('抓取失败：' + item.url + '\n' + item.message);
      fetched.push({ url: item.url, error: item.message });
      continue;
    }
    const heading = item.title ? item.title + '\n' + item.url : item.url;
    blocks.push(heading + '\n\n' + truncate(item.content.trim(), budget));
    fetched.push({ url: item.url, title: item.title, chars: item.content.length });
  }

  const failed = settled.filter((item) => !item.ok);
  if (failed.length === settled.length) {
    return { ok: false, errorCode: 'FETCH_FAILED', message: blocks.join('\n\n') };
  }

  return {
    ok: true,
    text: blocks.join('\n\n---\n\n'),
    results: fetched,
    meta: { engine: 'deepseek', requested: targets.length, failed: failed.length, keySource: resolved.source },
  };
}

async function executeStatus() {
  const resolved = resolveApiKey();
  const lines = [
    'DeepSeek 搜索插件',
    '  API Key：' + (resolved.key ? '已配置（' + resolved.source + '，' + resolved.key.slice(0, 6) + '…）' : '未配置'),
    '  Search：POST https://' + HOST + SEARCH_PATH,
    '  Fetch：POST https://' + HOST + FETCH_PATH,
    '  配置：环境变量 DEEPSEEK_API_KEY，或 ' + path.join(os.homedir(), '.cindy', 'deepseek-search.json'),
    '  计费：Search / Fetch 各 5 元每 1000 次成功请求，QPS 5',
  ];

  if (!resolved.key) {
    return { ok: false, errorCode: 'MISSING_API_KEY', message: lines.join('\n') };
  }

  try {
    const payload = await postJsonWithRetry(SEARCH_PATH, { query: 'DeepSeek API', count: 1 }, resolved.key);
    const total = Array.isArray(payload.results) ? payload.results.length : 0;
    lines.push('  连通性：正常（试搜索返回 ' + total + ' 条）');
    return { ok: true, text: lines.join('\n'), meta: { engine: 'deepseek', reachable: true } };
  } catch (error) {
    lines.push('  连通性：失败 — ' + (error && error.message ? error.message : String(error)));
    return { ok: false, errorCode: 'UNREACHABLE', message: lines.join('\n') };
  }
}

// ---------------------------------------------------------------- RPC 循环

const HANDLERS = {
  'deepseek/search': executeSearch,
  'deepseek/fetch': executeFetch,
  'deepseek/status': executeStatus,
};

let queue = Promise.resolve();

async function handle(request) {
  const id = request && request.id !== undefined ? request.id : null;
  const method = request && typeof request.method === 'string' ? request.method : '';
  const handler = HANDLERS[method];

  if (!handler) {
    reply({ jsonrpc: '2.0', id: id, error: { code: -32601, message: '不支持的方法：' + method } });
    return;
  }

  try {
    const result = await handler(request.params || {});
    reply({ jsonrpc: '2.0', id: id, result: result });
  } catch (error) {
    reply({
      jsonrpc: '2.0',
      id: id,
      result: {
        ok: false,
        errorCode: 'INTERNAL',
        message: error && error.message ? error.message : String(error),
      },
    });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求不是合法 JSON' } });
    return;
  }
  queue = queue.then(() => handle(request)).catch(() => {});
});

input.on('close', () => {
  queue.finally(() => process.exit(0));
});
