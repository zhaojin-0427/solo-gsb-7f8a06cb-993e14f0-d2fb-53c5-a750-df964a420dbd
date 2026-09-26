import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_PROPS,
  analyzeElement,
  compileRules,
  computeAllStyles,
  findByPath,
  parseHtml,
} from './src/engine.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const EXAMPLES_DIR = join(ROOT, 'examples');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 1024 * 1024; // 1MB
const MAX_RULES = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error('请求体不是合法的 JSON');
  }
}

/** 解析 HTML + 编译规则的公共步骤。 */
function buildContext(body) {
  const html = typeof body.html === 'string' ? body.html : '';
  const rules = (Array.isArray(body.rules) ? body.rules : []).slice(0, MAX_RULES);
  const { roots, errors: htmlErrors } = parseHtml(html);
  const { compiled, errors: ruleErrors, layerOrder } = compileRules(rules);
  return { roots, htmlErrors, compiled, ruleErrors, layerOrder };
}

async function handleCompute(req, res) {
  const body = await readJson(req);
  const { roots, htmlErrors, compiled, ruleErrors, layerOrder } = buildContext(body);
  const styles = htmlErrors.length ? {} : computeAllStyles(roots, compiled);
  sendJson(res, 200, {
    ok: htmlErrors.length === 0 && ruleErrors.length === 0,
    htmlErrors,
    ruleErrors,
    layerOrder,
    styles,
  });
}

async function handleAnalyze(req, res) {
  const body = await readJson(req);
  const property = body.property;
  if (!ALLOWED_PROPS.includes(property)) {
    sendJson(res, 400, { error: `属性必须是 ${ALLOWED_PROPS.join(' / ')} 之一` });
    return;
  }
  const { roots, htmlErrors, compiled, ruleErrors, layerOrder } = buildContext(body);
  if (htmlErrors.length) {
    sendJson(res, 200, { ok: false, htmlErrors, ruleErrors, layerOrder, matched: [], element: null });
    return;
  }
  const node = findByPath(roots, body.path);
  if (!node) {
    sendJson(res, 200, {
      ok: false,
      htmlErrors,
      ruleErrors,
      layerOrder,
      matched: [],
      element: null,
      message: '找不到该元素（HTML 可能已被修改），请重新点击预览中的元素',
    });
    return;
  }
  const matched = analyzeElement(node, property, compiled);
  sendJson(res, 200, {
    ok: true,
    htmlErrors,
    ruleErrors,
    layerOrder,
    matched,
    element: { tag: node.tag, id: node.id, classes: node.classes, path: node.path },
  });
}

async function handleExamples(res) {
  let files = [];
  try {
    files = (await readdir(EXAMPLES_DIR)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    /* 目录不存在时返回空列表 */
  }
  const examples = [];
  for (const file of files) {
    try {
      examples.push(JSON.parse(await readFile(join(EXAMPLES_DIR, file), 'utf8')));
    } catch {
      /* 跳过无法解析的示例文件 */
    }
  }
  sendJson(res, 200, examples);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let filePath;
  try {
    filePath = normalize(join(PUBLIC_DIR, decodeURIComponent(rel)));
  } catch {
    sendJson(res, 400, { error: '非法路径' });
    return;
  }
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not Found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && pathname === '/api/compute') return await handleCompute(req, res);
    if (req.method === 'POST' && pathname === '/api/analyze') return await handleAnalyze(req, res);
    if (req.method === 'GET' && pathname === '/api/examples') return await handleExamples(res);
    if (req.method === 'GET') return await serveStatic(req, res, pathname);
    sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    sendJson(res, err.message === '请求体过大' ? 413 : 400, { error: err.message || '服务器错误' });
  }
});

server.listen(PORT, () => {
  console.log(`CSS 层叠判定工作台已启动：http://localhost:${PORT}`);
});
