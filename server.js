#!/usr/bin/env node
/**
 * Ollama GUI — self-contained server, zero dependencies (Node 18+).
 *
 * Serves an advanced web frontend, proxies the Ollama REST API with SSE
 * streaming, manages conversations + a persistent "memory" that learns
 * facts about the user, and can optionally require an access token when
 * exposed on your LAN.
 *
 * CLI:  node server.js [--port N] [--host 0.0.0.0]
 * Env:  OLLAMA_HOST (base URL of the Ollama server, default http://127.0.0.1:11434)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { URL } = require('url');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const CONV_FILE = path.join(DATA, 'conversations.json');
const MEM_FILE = path.join(DATA, 'memory.json');

fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- config ----

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') o.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--host') o.host = argv[++i];
  }
  return o;
}
const cli = parseArgs(process.argv.slice(2));

function toBaseUrl(host) {
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '');
  return 'http://' + host.replace(/\/+$/, '');
}
function isHttpUrl(v) {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

// Default agent workspace — auto-created on demand.
function defaultWorkspace() {
  const p = path.join(os.homedir(), 'Ollama_Code_Output');
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
  return p;
}

let config = Object.assign({
  port: 8899,
  host: '127.0.0.1',
  ollamaBase: process.env.OLLAMA_HOST ? toBaseUrl(process.env.OLLAMA_HOST) : 'http://127.0.0.1:11434',
  accessToken: '',
  customUrl: '',
  autoTitle: true,
  autoMemory: true,
  defaultModels: [],
  imageModel: '',
  workspace: ''
}, loadJSON(CONFIG_FILE, {}));
if (cli.port) config.port = cli.port;
if (!config.workspace) { config.workspace = defaultWorkspace(); saveJSON(CONFIG_FILE, config); }
if (cli.host) config.host = cli.host;

// Sanitize whatever came from disk/CLI so a corrupt config can't break startup.
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) config.port = 8899;
if (typeof config.host !== 'string' || !config.host.trim() || config.host.length > 255) config.host = '127.0.0.1';
if (typeof config.ollamaBase !== 'string' || !isHttpUrl(config.ollamaBase)) config.ollamaBase = 'http://127.0.0.1:11434';
if (typeof config.accessToken !== 'string' || config.accessToken.length > 200) config.accessToken = '';
if (typeof config.customUrl !== 'string' || config.customUrl.length > 300) config.customUrl = '';
config.autoTitle = config.autoTitle !== false;
config.autoMemory = config.autoMemory !== false;
config.defaultModels = Array.isArray(config.defaultModels) ? config.defaultModels.filter((m) => typeof m === 'string' && m.trim() && m.length <= 200).slice(0, 20) : [];
config.imageModel = typeof config.imageModel === 'string' && config.imageModel.length <= 200 ? config.imageModel.trim() : '';
config.workspace = typeof config.workspace === 'string' && config.workspace.length <= 1000 ? config.workspace.trim() : '';

let conversations = loadJSON(CONV_FILE, []);
let memory = loadJSON(MEM_FILE, { notes: [], learned: [] });

const isLoopback = (h) => !h || h === '0.0.0.0' || h === '::' ? false :
  ['127.0.0.1', 'localhost', '::1'].includes(String(h).toLowerCase());

// Pick the IP this machine uses to reach the internet. Most machines have
// several interfaces (docker/vpn bridges would give a wrong, unreachable LAN
// address), so we discover the source IP for the default route with a UDP
// "connect" (never sends packets). Falls back to enumerating non-internal
// interfaces. Resolved once, then cached.
let lanIpCache = null;
let lanIpResolving = null;
function fallbackLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const i of nets[name]) {
      if (i && i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}
function resolveLanIp() {
  if (lanIpCache !== null) return Promise.resolve(lanIpCache);
  if (lanIpResolving) return lanIpResolving;
  lanIpResolving = new Promise((resolve) => {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      lanIpCache = ip;
      lanIpResolving = null;
      resolve(ip);
    };
    sock.once('error', () => finish(null));
    sock.once('connect', () => finish(sock.address().address));
    sock.connect(9, '8.8.8.8', () => {});
    setTimeout(() => finish(null), 600);
  });
  return lanIpResolving.then((ip) => ip || fallbackLanIp());
}
function lanIp() { // sync accessor for the startup banner
  if (lanIpCache !== null) return lanIpCache;
  return fallbackLanIp();
}
async function effectiveAddresses() {
  const ip = await resolveLanIp();
  const lan = !isLoopback(config.host) && ip ? `http://${ip}:${config.port}` : null;
  return { local: `http://127.0.0.1:${config.port}`, lan, custom: config.customUrl || null };
}

// ------------------------------------------------------------- helpers ----

const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const now = () => new Date().toISOString();

function persistConversations() { saveJSON(CONV_FILE, conversations); }
function persistMemory() { saveJSON(MEM_FILE, memory); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function ollama(pathname, options = {}) {
  const url = config.ollamaBase + pathname;
  const res = await fetch(url, Object.assign({ signal: options.signal, method: options.method || 'GET' }, options.body !== undefined ? { body: JSON.stringify(options.body) } : {}, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  }));
  return res;
}

async function ollamaError(res) {
  let text = '';
  try { text = (await res.text()).slice(0, 400); } catch {}
  return `Ollama ${res.status}: ${text || res.statusText}`;
}

// ------------------------------------------------------------ SSE output ----

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });
}
function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ------------------------------------------------------------- auth ---------

const crypto = require('crypto');
function authorized(req) {
  if (!config.accessToken) return true;
  const q = new URL(req.url, 'http://x').searchParams.get('token');
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : (q || '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.accessToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------ model management ---------

async function apiTags() {
  const res = await ollama('/api/tags');
  if (!res.ok) throw new Error(await ollamaError(res));
  const j = await res.json();
  return j.models || [];
}

async function apiPull(req, res, body) {
  sseHeaders(res);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const name = String(body.name || '').trim();
  if (!name) { sseSend(res, 'error', { message: 'Missing model name' }); return res.end(); }
  let upstream;
  try {
    upstream = await ollama('/api/pull', { method: 'POST', body: { name, stream: true }, signal: ctrl.signal });
  } catch (e) { sseSend(res, 'error', { message: 'Cannot reach Ollama: ' + e.message }); return res.end(); }
  if (!upstream.ok) { sseSend(res, 'error', { message: await ollamaError(upstream) }); return res.end(); }
  try {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        sseSend(res, 'chunk', j);
        if (j.status === 'success') break;
      }
      if (buf.includes('"success"')) break;
    }
  } catch { sseSend(res, 'error', { message: 'Pull stream interrupted' }); }
  sseSend(res, 'done', {});
  res.end();
}

// ------------------------------------------------------ streaming chat ------

async function chatStream(req, res, body) {
  sseHeaders(res);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  if (!body || !Array.isArray(body.messages)) { sseSend(res, 'error', { message: 'Missing messages' }); return res.end(); }

  let upstream;
  try {
    upstream = await ollama('/api/chat', { method: 'POST', body: { model: body.model, messages: body.messages, stream: true, options: body.options || {}, keep_alive: body.keep_alive }, signal: ctrl.signal });
  } catch (e) { sseSend(res, 'error', { message: 'Cannot reach Ollama: ' + e.message }); return res.end(); }
  if (!upstream.ok) { sseSend(res, 'error', { message: await ollamaError(upstream) }); return res.end(); }

  try {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        sseSend(res, 'chunk', j);
      }
    }
  } catch (e) { ctrl.abort(); sseSend(res, 'error', { message: 'Stream interrupted' }); }
  sseSend(res, 'done', {});
  res.end();
}

// --------------------------------------------------------- agent (coding) ----
// Workspace-scoped coding agent: the model emits <toolcall> XML blocks, the
// server executes them (cwd = workspace), and the loop repeats until the model
// answers in plain text.

const { exec } = require('child_process');
const AGENT_MAX_STEPS = 20;
const AGENT_TOOL_TIMEOUT = 120000;
const AGENT_MAX_OUTPUT = 6000;

const TOOLCALL_RE = /<toolcall>\s*([\s\S]*?)<\/toolcall>/i;
function extractToolcall(buf) {
  const m = TOOLCALL_RE.exec(buf);
  if (!m) return null;
  const inner = m[1];
  const name = ((inner.match(/<task>\s*([\s\S]*?)\s*<\/task>/i) || [])[1] || (inner.match(/<name>\s*([\s\S]*?)\s*<\/name>/i) || [])[1] || '').trim().toLowerCase();
  const arg = ((inner.match(/<arg>\s*([\s\S]*?)\s*<\/arg>/i) || [])[1] || (inner.match(/<input>\s*([\s\S]*?)\s*<\/input>/i) || [])[1] || '').trim();
  if (!name || name.length > 40 || arg.length > 20000) return null;
  return { name, arg };
}

function workspacePath(rel) {
  const root = path.resolve(config.workspace);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function execTool(cmd) {
  return new Promise((resolve) => {
    if (!cmd) return resolve({ ok: false, output: 'Empty command', code: null });
    exec(cmd, { cwd: config.workspace, shell: '/bin/bash', timeout: AGENT_TOOL_TIMEOUT, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = String(stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
      out = (out.trim() || '(no output)').slice(0, AGENT_MAX_OUTPUT);
      const code = err ? (typeof err.code === 'number' ? err.code : (err.signal ? 'killed by signal ' + err.signal : 'error')) : 0;
      resolve({ ok: !err, output: out, code });
    });
  });
}

function readTool(rel) {
  return new Promise((resolve) => {
    const abs = workspacePath(rel);
    if (!abs) return resolve({ ok: false, output: 'Path escapes the workspace: ' + rel });
    fs.readFile(abs, 'utf8', (err, data) => {
      if (err) return resolve({ ok: false, output: 'Read failed: ' + err.message });
      resolve({ ok: true, output: (data || '').slice(0, AGENT_MAX_OUTPUT) });
    });
  });
}

function writeTool(rel) {
  return new Promise((resolve) => {
    const nl = rel.indexOf('\n');
    const fileRel = (nl >= 0 ? rel.slice(0, nl) : rel).trim();
    const content = nl >= 0 ? rel.slice(nl + 1) : '';
    const abs = workspacePath(fileRel);
    if (!abs) return resolve({ ok: false, output: 'Path escapes the workspace: ' + fileRel });
    fs.mkdir(path.dirname(abs), { recursive: true }, (me) => {
      if (me) return resolve({ ok: false, output: 'Mkdir failed: ' + me.message });
      fs.writeFile(abs, content, 'utf8', (err) => {
        resolve(err ? { ok: false, output: 'Write failed: ' + err.message } : { ok: true, output: 'Wrote ' + fileRel + ' (' + content.length + ' bytes)' });
      });
    });
  });
}

function listTool(rel) {
  return new Promise((resolve) => {
    const abs = workspacePath(rel || '.');
    if (!abs) return resolve({ ok: false, output: 'Path escapes the workspace: ' + rel });
    fs.readdir(abs, { withFileTypes: true }, (err, entries) => {
      if (err) return resolve({ ok: false, output: 'List failed: ' + err.message });
      resolve({ ok: true, output: entries.map(e => (e.isDirectory() ? e.name + '/' : e.isFile() ? e.name : e.name + ' *')).sort().join('\n') || '(empty)' });
    });
  });
}

async function runAgentTool(tool) {
  if (tool.name === 'run') return execTool(tool.arg);
  if (tool.name === 'read') return readTool(tool.arg);
  if (tool.name === 'write') return writeTool(tool.arg);
  if (tool.name === 'list') return listTool(tool.arg);
  return { ok: false, output: 'Unknown tool "' + tool.name + '" — use run, read, write, or list' };
}

// Runs a shell command in the workspace and captures stdout/stderr. Never throws.
function runSh(cmd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: config.workspace, shell: '/bin/bash', timeout: timeout || AGENT_TOOL_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = String(stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
      out = (out.trim() || '(no output)').slice(0, AGENT_MAX_OUTPUT);
      const code = err ? (typeof err.code === 'number' ? err.code : (err.signal ? 'killed by signal ' + err.signal : 'error')) : 0;
      resolve({ ok: !err, output: out, code });
    });
  });
}

// Preflight: detect project manifests in the workspace and install missing deps.
// Returns an array of { lang, manifest, status, detail } reports.
async function checkDependencies() {
  const cwd = config.workspace;
  const reports = [];
  const has = (f) => fs.existsSync(path.join(cwd, f));
  const pkgText = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } };

  // --- Node.js ---
  if (has('package.json')) {
    const pre = await runSh('node -e "try{const p=require(\'./package.json\');console.log(JSON.stringify({deps:!!(p.dependencies&&Object.keys(p.dependencies).length),dev:!!(p.devDependencies&&Object.keys(p.devDependencies).length)}))}catch(e){console.log(\'err\')}"', 30000);
    const wantsDeps = /"deps":true/.test(pre.output) || /"dev":true/.test(pre.output);
    if (wantsDeps) {
      const missing = await runSh('npm ls --depth=0 --json 2>/dev/null; echo "EXIT:$?"', 60000);
      const npmMissing = /EXIT:[1-9]/.test(missing.output) || /"problems"|node_modules\\"?[^"]*"?: "missing/.test(missing.output);
      if (npmMissing || !has('node_modules')) {
        const inst = await runSh('npm install --no-audit --no-fund 2>&1', 300000);
        reports.push({ lang: 'node', manifest: 'package.json', status: inst.ok ? 'installed' : 'failed', detail: inst.output.slice(0, AGENT_MAX_OUTPUT) });
      } else {
        reports.push({ lang: 'node', manifest: 'package.json', status: 'ok', detail: 'dependencies already installed' });
      }
    } else {
      reports.push({ lang: 'node', manifest: 'package.json', status: 'ok', detail: 'no dependencies declared' });
    }
  }

  // --- Python ---
  const pyManifest = has('requirements.txt') ? 'requirements.txt' : (has('pyproject.toml') ? 'pyproject.toml' : '');
  if (pyManifest) {
    // Prefer a project-local .venv, else system python; auto-create a .venv if
    // system pip is blocked (PEP 668 "externally-managed" environments).
    const whichPy = async () => {
      for (const p of ['python3', 'python']) { const t = await runSh('command -v ' + p + ' 2>/dev/null', 15000); const line = ((t.output || '').split('\n')[0] || '').trim(); if (line) return line; }
      return null;
    };
    const py = await whichPy();
    const venv = path.join(cwd, '.venv');
    const venvPy = path.join(venv, 'bin', 'python');
    const venvPip = path.join(venv, 'bin', 'pip');
    const usingVenv = fs.existsSync(venvPy);
    const pipFor = (which) => (which === 'venv' ? venvPip : (py || 'python3') + ' -m pip');
    if (py) {
      let needInstall = false;
      if (pyManifest === 'requirements.txt') {
        const wants = pkgText('requirements.txt').split('\n').map((l) => l.split(/[#;]/)[0].trim()).filter(Boolean);
        const freeze = await runSh(pipFor(usingVenv ? 'venv' : 'sys') + ' freeze 2>/dev/null || echo "(pip unavailable)"', 60000);
        const frozen = (freeze.output || '').includes('(pip unavailable)') ? '' : (freeze.output || '');
        if (!frozen) needInstall = wants.length > 0;
        else {
          const installed = new Set(frozen.split('\n').map((l) => l.split(/[=<>!~]/)[0].trim().toLowerCase()).filter(Boolean));
          needInstall = wants.some((line) => {
            const name = line.split(/[=<>!~[\]@]/)[0].trim().toLowerCase();
            return name && !installed.has(name);
          });
        }
      } else {
        needInstall = true;
      }
      if (needInstall) {
        const installCmd = (which) => (pyManifest === 'requirements.txt' ? pipFor(which) + ' install -r requirements.txt 2>&1' : pipFor(which) + ' install -e . 2>&1');
        let inst = await runSh(installCmd(usingVenv ? 'venv' : 'sys'), 300000);
        if (!inst.ok && !usingVenv && /externally-managed/.test(inst.output)) {
          const mk = await runSh(py + ' -m venv ' + venv + ' 2>&1', 120000);
          if (mk.ok) {
            inst = await runSh(installCmd('venv'), 300000);
            reports.push({ lang: 'python', manifest: pyManifest, status: inst.ok ? 'installed' : 'failed', detail: (inst.ok ? 'created .venv and installed packages\n' : 'created .venv but install failed\n') + inst.output.slice(0, AGENT_MAX_OUTPUT) });
          }
        } else {
          reports.push({ lang: 'python', manifest: pyManifest, status: inst.ok ? 'installed' : 'failed', detail: inst.output.slice(0, AGENT_MAX_OUTPUT) });
        }
      } else {
        reports.push({ lang: 'python', manifest: pyManifest, status: 'ok', detail: 'dependencies already installed' });
      }
    }
  }

  // --- Go ---
  if (has('go.mod') && has('go.sum')) {
    const pre = await runSh('go list -m all >/dev/null 2>&1; echo "EXIT:$?"', 60000);
    if (/EXIT:[1-9]/.test(pre.output) || !has('vendor')) {
      const inst = await runSh('go mod download 2>&1', 300000);
      reports.push({ lang: 'go', manifest: 'go.mod', status: inst.ok ? 'installed' : 'failed', detail: inst.output.slice(0, AGENT_MAX_OUTPUT) });
    } else {
      reports.push({ lang: 'go', manifest: 'go.mod', status: 'ok', detail: 'modules already downloaded' });
    }
  }

  // --- Ruby ---
  if (has('Gemfile')) {
    const frozen = await runSh('bundle check 2>&1; echo "EXIT:$?"', 60000);
    if (/EXIT:[1-9]/.test(frozen.output)) {
      const inst = await runSh('bundle install 2>&1', 300000);
      reports.push({ lang: 'ruby', manifest: 'Gemfile', status: inst.ok ? 'installed' : 'failed', detail: inst.output.slice(0, AGENT_MAX_OUTPUT) });
    } else {
      reports.push({ lang: 'ruby', manifest: 'Gemfile', status: 'ok', detail: 'gems already installed' });
    }
  }

  return reports;
}

function agentSystemPrompt() {
  return [
    'You are an expert coding agent operating inside a workspace on the user\'s computer.',
    'Workspace directory: ' + config.workspace,
    'The server auto-installs the project\'s dependencies (package.json, requirements.txt, pyproject.toml, go.mod, Gemfile) before your turn when they are missing, so you do not need to run npm install / pip install yourself.',
    'OS: ' + (process.platform === 'linux' ? 'Linux' : process.platform) + '. Shell commands run with the workspace as their current directory.',
    'You solve programming tasks by sending tool calls. Each tool call must be your ENTIRE reply for that turn, in this exact shape:',
    '<toolcall><task>TOOL</task><arg>ARG</arg></toolcall>',
    'Available tools:',
    '- run: execute a shell command (cwd = workspace). Use `cd subdir && ...` inside the command when needed. Example: <toolcall><task>run</task><arg>ls -la</arg></toolcall>',
    '- read: read a file. ARG = path relative to the workspace. Example: <toolcall><task>read</task><arg>src/index.js</arg></toolcall>',
    '- write: create or overwrite a file. ARG = RELATIVE_PATH, a newline, then the full file content. Example: <toolcall><task>write</task><arg>hello.txt\nHello world!</arg></toolcall>',
    '- list: list a directory. ARG = path relative to the workspace (default ".").',
    'Rules:',
    '1. Send exactly ONE tool call per reply, then wait for the result. Never pack multiple toolcalls into one reply and never add text after the toolcall block.',
    '2. Continue with more tool calls until the task is done.',
    '3. When finished, reply with your answer in PLAIN TEXT only — no toolcall block.',
    '4. Do not nest <tags> inside <arg> content; if file content includes "</arg>", write it as &lt;/arg&gt;.',
    '5. Verify your work (run/build/test) before concluding.'
  ].join('\n');
}

// Streams an upstream chat response; forwards model text that is NOT inside a
// <toolcall> block (so the raw XML never reaches the UI). Returns the parsed tool.
async function readAgentStep(upstream, onText, abort) {
  const dec = new TextDecoder();
  let buf = '';
  let raw = '';         // every delta appended, used for tool extraction
  let pending = '';     // received but not yet committed to the client
  let inside = false;   // inside <toolcall>...</toolcall> (holds everything)
  let cand = null;
  for await (const chunk of upstream.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const delta = (j.message && j.message.content) || '';
      if (!delta) continue;
      raw += delta;
      pending += delta;
      // Forward narrative text, but hold back the last 8 chars in case they are
      // the start of a <toolcall tag due to arrive in the next delta.
      while (true) {
        if (!inside) {
          const i = pending.indexOf('<toolcall');
          if (i >= 0) {
            const pre = pending.slice(0, i);
            if (pre && !abort.aborted) onText(pre);
            pending = pending.slice(i);
            inside = true;
            continue;
          }
          if (pending.length > 8) {
            const safe = pending.length - 8;
            const pre = pending.slice(0, safe);
            if (pre && !abort.aborted) onText(pre);
            pending = pending.slice(safe);
          }
          break;
        }
        const j = pending.indexOf('</toolcall>');
        if (j >= 0) {
          pending = pending.slice(j + 11);
          inside = false;
          continue;
        }
        break; // block still incomplete — hold everything
      }
      if (!cand) { try { cand = extractToolcall(raw); } catch {} }
      if (cand) break;
    }
    if (cand) break;
  }
  if (cand) { abort.abort(); return cand; }
  if (!inside && pending && !abort.aborted) onText(pending);
  return null;
}

function agentHandler(req, res, body) {
  sseHeaders(res);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  if (!body || !Array.isArray(body.messages)) { sseSend(res, 'error', { message: 'Missing messages' }); return res.end(); }
  const model = String(body.model || '').trim();
  if (!config.workspace) { sseSend(res, 'error', { message: 'No agent workspace configured — open Settings → General → Agent workspace' }); return res.end(); }
  if (!model) { sseSend(res, 'error', { message: 'Pick a model first' }); return res.end(); }
  (async () => {
    const working = [{ role: 'system', content: agentSystemPrompt() }];
    working.push(...body.messages
      .filter(m => m.type !== 'image')
      .map(m => ({ role: m.role, content: String(m.content || '').trim() }))
      .filter(m => m.content)
      .slice(-24));
    let finalText = '';
    // Preflight: check + install workspace dependencies, report before the tool loop.
    try {
      const reports = await checkDependencies();
      for (const r of reports) sseSend(res, 'deps', r);
    } catch (e) { console.error('[deps]', e && e.stack ? e.stack : e); }
    for (let step = 0; step < AGENT_MAX_STEPS; step++) {
      const stepAbort = new AbortController();
      const onAbort = () => stepAbort.abort();
      ctrl.signal.addEventListener('abort', onAbort, { once: true });
      let upstream;
      try {
        upstream = await ollama('/api/chat', { method: 'POST', body: { model, messages: working, stream: true, options: { temperature: 0.2 } }, signal: stepAbort.signal });
      } catch (e) { ctrl.signal.removeEventListener('abort', onAbort); sseSend(res, 'error', { message: 'Cannot reach Ollama: ' + e.message }); return res.end(); }
      if (!upstream.ok) { ctrl.signal.removeEventListener('abort', onAbort); sseSend(res, 'error', { message: await ollamaError(upstream) }); return res.end(); }
      let stepText = '';
      const tool = await readAgentStep(upstream, (t) => { finalText += t; stepText += t; sseSend(res, 'delta', { text: t }); }, stepAbort);
      if (ctrl.signal.aborted || res.destroyed) { sseSend(res, 'done', {}); return res.end(); }
      if (!tool) {
        sseSend(res, 'done', { text: finalText });
        return res.end();
      }
      const result = await runAgentTool(tool);
      working.push({ role: 'assistant', content: stepText + '<toolcall><task>' + tool.name + '</task><arg>' + tool.arg + '</arg></toolcall>' });
      working.push({ role: 'user', content: '[Tool result for ' + tool.name + ']\n' + result.output + (result.ok ? '' : '  (exit: ' + result.code + ')') });
      sseSend(res, 'tool', { name: tool.name, arg: tool.arg });
      sseSend(res, 'tool-result', { name: tool.name, ok: result.ok, output: result.output, code: result.code });
    }
    sseSend(res, 'done', { text: finalText, stopped: true });
    res.end();
  })().catch((e) => { try { console.error('[agent]', e && e.stack ? e.stack : e); sseSend(res, 'error', { message: 'Agent error' }); res.end(); } catch {} });
}

// -------------------------------------------------------------- images ------

// Strong, unambiguous "create a visual" cues — fast path, no model call needed.
const IMG_STRONG = /\b(draw|paint|sketch|generate|create|invent|design|render|animate|imagine)\b.?.?\b(image|picture|photo|selfie|logo|avatar|icon|illustration|diagram|chart|graph|poster|banner|wallpaper|artwork|painting|comic|manga|meme|caricature|cover art|thumbnail)\b/i;

// Ask "the brain" (the active chat model) to classify intent. Outputs a single word.
async function classifyRoute(text, model) {
  const sys = 'You are a request router. Decide whether the user is asking you to CREATE A VISUAL — an image, picture, photo, logo, avatar, icon, illustration, diagram, chart, poster, banner, wallpaper, meme, manga, artwork, etc. — that would be generated by an image model.\nReply with exactly one lowercase word, nothing else: "image" or "chat".';
  const r = await ollama('/api/generate', {
    method: 'POST',
    body: {
      model,
      prompt: sys + '\n\nUser request: ' + String(text || '').trim(),
      stream: false,
      options: { temperature: 0, num_predict: 12 }
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) return null;
  const j = await r.json();
  return /^image/i.test(String(j.response || '').trim()) ? 'image' : 'chat';
}

function routeRequest(req, res, body) {
  const text = String(body.text || '').trim();
  const model = String(body.model || config.imageModel || '').trim().slice(0, 200);
  const respond = (action) => res.end(JSON.stringify({ action }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (!text) return respond('chat');
  if (IMG_STRONG.test(text)) return respond('image');
  if (!model) return respond('chat');
  classifyRoute(text, model).then(action => respond(action === null ? 'chat' : action)).catch(() => respond('chat'));
  return;
}

async function imageGenerate(req, res, body) {
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const prompt = String(body.prompt || '').trim();
  const model = String(body.model || config.imageModel || '').trim();
  const size = /^\d{2,5}x\d{2,5}$/.test(String(body.size || '')) ? String(body.size) : '1024x1024';
  if (!prompt) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Empty prompt' })); }
  if (!model) { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'No image model configured — set "Image model" in Settings' })); }

  // Primary path: standard /api/generate — Ollama auto-detects image models.
  let image = null, used = 'generate';
  try {
    const r = await ollama('/api/generate', { method: 'POST', body: { model, prompt, stream: false }, signal: ctrl.signal });
    if (r.ok) {
      const j = await r.json();
      if (j.images && j.images.length) image = 'data:image/png;base64,' + j.images[0];
    }
  } catch {}
  // Fallback: OpenAI-compatible images endpoint.
  if (!image) {
    used = 'v1';
    try {
      const r = await ollama('/v1/images/generations', { method: 'POST', body: { model, prompt, size, response_format: 'b64_json' }, signal: ctrl.signal });
      if (r.ok) {
        const j = await r.json();
        const b = j.data && j.data[0] && j.data[0].b64_json;
        if (b) image = 'data:image/png;base64,' + b;
      }
    } catch {}
  }
  if (!image) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Image generation failed — is "' + model + '" an image model?' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, image, model, prompt, used }));
}

// -------------------------------------------------------------- memory ------

const EXTRACT_SYSTEM =
  'You are an expert knowledge-extraction engine integrated into a chat UI. ' +
  'Read the conversation below. Extract only STABLE, DURABLE facts about the user: their preferences, ' +
  'goals, technical setup, projects, constraints, and personal details they shared. ' +
  'Ignore one-off small talk. Output ONLY a raw JSON array of strings, one fact per element, ' +
  'e.g. ["Prefers dark mode", "Works on a Node.js project"]. If there is nothing durable, output []. ' +
  'Do not output anything other than the JSON array.';

function normalizeFact(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function factExists(fact, list) {
  const n = normalizeFact(fact);
  if (!n) return true;
  return list.some((e) => {
    const m = normalizeFact(e.text);
    if (!m) return false;
    return m === n || m.includes(n) || n.includes(m);
  });
}

async function extractFacts(req, res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const conv = conversations.find((c) => c.id === body.conversationId);
  if (!conv) { res.end(JSON.stringify({ created: 0, message: 'Conversation not found' })); return; }
  const userMsgs = conv.messages.filter((m) => m.role === 'user').map((m) => m.content).slice(-12);
  if (!userMsgs.length) { res.end(JSON.stringify({ created: 0, message: 'No user messages yet' })); return; }

  const prompt = userMsgs.map((m, i) => `USER ${i + 1}: ${m}`).join('\n\n');
  let created = [];
  try {
    const upstream = await ollama('/api/generate', { method: 'POST', body: {
      model: conv.model, prompt, system: EXTRACT_SYSTEM, stream: false, options: { temperature: 0.1 }
    }, signal: req.abortController && req.abortController.signal });
    if (upstream.ok) {
      const j = await upstream.json();
      const text = String(j.response || '');
      let facts = [];
      try { facts = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || '[]'); }
      catch { facts = text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean); }
      if (Array.isArray(facts)) {
        for (const f of facts.slice(0, 12)) {
          const t = String(f).trim();
          if (!t) continue;
          if (factExists(t, memory.learned) || factExists(t, memory.notes)) continue;
          const entry = { id: uid(), text: t, tags: ['learned'], sourceId: conv.id, createdAt: now(), learned: true };
          memory.learned.unshift(entry);
          created.push(entry);
        }
        persistMemory();
      }
    }
  } catch (e) { /* skip */ }
  res.end(JSON.stringify({ created: created.length, facts: created }));
}

// --------------------------------------------------------- auto title --------

async function makeTitle(req, res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const conv = conversations.find((c) => c.id === body.conversationId);
  if (!conv || !conv.messages.length) { res.end(JSON.stringify({ title: null })); return; }
  const first = conv.messages.find((m) => m.role === 'user');
  if (!first) { res.end(JSON.stringify({ title: null })); return; }
  const prompt = 'Write a very short title (max 8 words, no quotes, no punctuation) for a chat that starts with this message:\n"' +
    String(first.content).slice(0, 600) + '"';
  try {
    const upstream = await ollama('/api/generate', { method: 'POST', body: {
      model: conv.model, prompt, system: 'You only output a short chat title.', stream: false, options: { temperature: 0.2 }
    }, signal: req.abortController && req.abortController.signal });
    if (upstream.ok) {
      const j = await upstream.json();
      const t = String(j.response || '').trim().replace(/["\n]/g, '').slice(0, 80);
      if (t) { conv.title = t; conv.updatedAt = now(); persistConversations(); }
      res.end(JSON.stringify({ title: t }));
      return;
    }
  } catch {}
  res.end(JSON.stringify({ title: null }));
}

// ---------------------------------------------------------- conversations ----

function publicConv(c) {
  return { id: c.id, title: c.title, model: c.model, system: c.system, params: c.params || {},
    useMemory: c.useMemory !== false, createdAt: c.createdAt, updatedAt: c.updatedAt,
    messageCount: (c.messages || []).length };
}
function findConv(id) { return conversations.find((c) => c.id === id); }

// ------------------------------------------------------- request handler ----

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const isApi = p.startsWith('/api/');
  if (isApi && !authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'X-Ollama-Gui-Auth': '1' });
    return res.end(JSON.stringify({ error: 'Access token required' }));
  }

  // Signal support for internal upstream calls
  const ctrl = new AbortController();
  req.abortController = ctrl;
  req.on('close', () => ctrl.abort());

  try {
    // ---- static ----
    if (req.method === 'GET' && !isApi) {
      let rel = u.pathname === '/' ? '/index.html' : u.pathname;
      let file = path.normalize(path.join(PUB, rel));
      if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('Forbidden'); }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(PUB, 'index.html');
      }
      const ext = path.extname(file).toLowerCase();
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
      const data = fs.readFileSync(file);
      const enc = req.headers['accept-encoding'] || '';
      const gzipOk = enc.includes('gzip') && data.length > 256;
      res.writeHead(200, Object.assign({ 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' }, gzipOk ? { 'Content-Encoding': 'gzip' } : {}));
      return res.end(gzipOk ? zlib.gzipSync(data) : data);
    }

    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};

    // ---- config ----
    if (p === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ port: config.port, host: config.host, ollamaBase: config.ollamaBase, customUrl: config.customUrl, autoTitle: config.autoTitle, autoMemory: config.autoMemory, defaultModels: config.defaultModels, imageModel: config.imageModel, workspace: config.workspace }));
    }
    if (p === '/api/config' && req.method === 'POST') {
      const prev = { port: config.port, host: config.host };
      if (typeof body.ollamaBase === 'string') {
        const base = toBaseUrl(body.ollamaBase.trim());
        if (!isHttpUrl(base) || base.length > 2048) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Ollama server URL must be a valid http(s) URL' }));
        }
        config.ollamaBase = base;
      }
      if (typeof body.accessToken === 'string' && body.accessToken.length <= 200) config.accessToken = body.accessToken.trim();
      if (typeof body.customUrl === 'string') {
        const v = body.customUrl.trim();
        if (v && !isHttpUrl(v)) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Custom URL must be a valid http(s) URL (or leave empty)' }));
        }
        if (v.length <= 300) config.customUrl = v;
      }
      if (typeof body.autoTitle === 'boolean') config.autoTitle = body.autoTitle;
      if (typeof body.autoMemory === 'boolean') config.autoMemory = body.autoMemory;
      if (Array.isArray(body.defaultModels)) config.defaultModels = body.defaultModels.filter((m) => typeof m === 'string' && m.trim() && m.length <= 200).map((m) => m.trim()).slice(0, 20);
      if (typeof body.imageModel === 'string') config.imageModel = body.imageModel.trim().slice(0, 200);
      if (typeof body.workspace === 'string') {
        let v = body.workspace.trim().slice(0, 1000);
        if (!v) {
          config.workspace = defaultWorkspace();
        } else {
          if (!fs.existsSync(v)) { try { fs.mkdirSync(v, { recursive: true }); } catch {} }
          if (!fs.existsSync(v)) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Workspace path does not exist and could not be created: ' + v }));
          }
          config.workspace = v;
        }
      }
      let newPort = body.port !== undefined ? Number(body.port) : config.port;
      let newHost = body.host !== undefined ? String(body.host) : config.host;
      if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Port must be a number between 1 and 65535' }));
      }
      if (!newHost || newHost.length > 255) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid host (must be an IP, hostname, or 0.0.0.0)' }));
      }
      config.port = newPort;
      config.host = newHost;
      const needsRestart = prev.port !== config.port || prev.host !== config.host;
      saveJSON(CONFIG_FILE, config);
      const addrs = await effectiveAddresses();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, needsRestart, previous: prev, config: { port: config.port, host: config.host, ollamaBase: config.ollamaBase, customUrl: config.customUrl, autoTitle: config.autoTitle, autoMemory: config.autoMemory, defaultModels: config.defaultModels, imageModel: config.imageModel, workspace: config.workspace }, addresses: addrs }));
      if (needsRestart) setTimeout(restartServer, 250);
      return;
    }

    // ---- health ----
    if (p === '/api/health') {
      let ollamaStatus = { ok: false, version: null, error: null };
      try { const r = await ollama('/api/version'); if (r.ok) ollamaStatus = { ok: true, version: (await r.json()).version || null }; else ollamaStatus.error = await ollamaError(r); }
      catch (e) { ollamaStatus.error = e.message; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const addrs = await effectiveAddresses();
      return res.end(JSON.stringify({ gui: { ok: true, auth: !!config.accessToken, loopback: isLoopback(config.host) }, ollama: ollamaStatus, config: { ollamaBase: config.ollamaBase, customUrl: config.customUrl, autoTitle: config.autoTitle, autoMemory: config.autoMemory, port: config.port, host: config.host, defaultModels: config.defaultModels, imageModel: config.imageModel, workspace: config.workspace }, addresses: addrs }));
    }

    // ---- models ----
    if (p === '/api/models' && req.method === 'GET') {
      try { const list = await apiTags(); return res.end(JSON.stringify(list)); }
      catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (p === '/api/model' && req.method === 'POST') {
      try {
        const upstream = await ollama('/api/show', { method: 'POST', body: { name: body.name || '' } });
        if (!upstream.ok) throw new Error(await ollamaError(upstream));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(await upstream.json()));
      } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }
    const delMatch = p.match(/^\/api\/model\/([^/]+)$/);
    if (delMatch && req.method === 'DELETE') {
      try {
        const upstream = await ollama('/api/delete', { method: 'DELETE', body: { name: decodeURIComponent(delMatch[1]) } });
        if (!upstream.ok) throw new Error(await ollamaError(upstream));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (p === '/api/pull' && req.method === 'POST') return apiPull(req, res, body);

    // ---- chat / generate ----
    if (p === '/api/chat' && req.method === 'POST') return chatStream(req, res, body);
    if (p === '/api/generate' && req.method === 'POST') {
      const ctrl2 = new AbortController(); req.abortController = ctrl2; req.on('close', () => ctrl2.abort());
      try {
        const upstream = await ollama('/api/generate', { method: 'POST', body: { ...body, stream: false }, signal: ctrl2.signal });
        const text = await upstream.text();
        if (!upstream.ok) throw new Error(text.slice(0, 300));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(text);
      } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (p === '/api/title' && req.method === 'POST') return makeTitle(req, res, body);
    if (p === '/api/image' && req.method === 'POST') return imageGenerate(req, res, body);
    if (p === '/api/route' && req.method === 'POST') return routeRequest(req, res, body);
    if (p === '/api/agent' && req.method === 'POST') return agentHandler(req, res, body);

    // ---- conversations ----
    if (p === '/api/conversations' && req.method === 'GET') {
      const sorted = [...conversations].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ conversations: sorted.map(publicConv) }));
    }
    if (p === '/api/conversations' && req.method === 'POST') {
      const c = { id: uid(), title: body.title || 'New chat', model: body.model || '', system: body.system || '', params: body.params || {}, useMemory: body.useMemory !== false, createdAt: now(), updatedAt: now(), messages: [] };
      conversations.unshift(c);
      persistConversations();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ conversation: publicConv(c), id: c.id }));
    }
    const convMatch = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch) {
      const id = decodeURIComponent(convMatch[1]);
      const c = findConv(id);
      if (!c) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Not found' })); }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ conversation: c }));
      }
      if (req.method === 'PATCH') {
        if (typeof body.title === 'string') c.title = body.title;
        if (typeof body.model === 'string') c.model = body.model;
        if (typeof body.system === 'string') c.system = body.system;
        if (body.params && typeof body.params === 'object') c.params = body.params;
        if (typeof body.useMemory === 'boolean') c.useMemory = body.useMemory;
        if (Array.isArray(body.messages)) c.messages = body.messages;
        c.updatedAt = now();
        persistConversations();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ conversation: publicConv(c) }));
      }
      if (req.method === 'DELETE') {
        conversations = conversations.filter((x) => x.id !== id);
        persistConversations();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
    }

    // ---- export / import ----
    if (p === '/api/export' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ exportedAt: now(), app: 'ollama-gui', conversations, memory }));
    }
    if (p === '/api/import' && req.method === 'POST') {
      let imported = 0, memImported = 0;
      if (Array.isArray(body.conversations)) {
        for (const x of body.conversations) {
          if (!findConv(x.id)) { conversations.push({ id: x.id || uid(), title: x.title || 'Imported', model: x.model || '', system: x.system || '', params: x.params || {}, useMemory: x.useMemory !== false, createdAt: x.createdAt || now(), updatedAt: x.updatedAt || now(), messages: Array.isArray(x.messages) ? x.messages : [] }); imported++; }
          else { const c = findConv(x.id); if (Array.isArray(x.messages)) c.messages = x.messages; c.updatedAt = now(); imported++; }
        }
      }
      if (body.memory && Array.isArray(body.memory.learned)) {
        for (const f of body.memory.learned) { if (!memory.learned.find((e) => e.id === f.id)) { memory.learned.push(f); memImported++; } }
      }
      if (body.memory && Array.isArray(body.memory.notes)) {
        for (const n of body.memory.notes) { memory.notes.push(n); memImported++; }
      }
      persistConversations(); persistMemory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ imported, memImported }));
    }
    if (p === '/api/reset' && req.method === 'POST') {
      conversations = []; memory = { notes: [], learned: [] };
      persistConversations(); persistMemory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // ---- memory ----
    if (p === '/api/memory' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(memory));
    }
    if (p === '/api/memory' && req.method === 'POST') {
      const t = String(body.text || '').trim();
      if (!t) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Empty text' })); }
      const note = { id: uid(), text: t, tags: Array.isArray(body.tags) ? body.tags : [], enabled: body.enabled !== false, global: body.global !== false, createdAt: now(), updatedAt: now(), learned: false };
      memory.notes.unshift(note);
      persistMemory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(note));
    }
    const memMatch = p.match(/^\/api\/memory\/([^/]+)$/);
    if (memMatch) {
      const id = decodeURIComponent(memMatch[1]);
      const all = [...memory.notes, ...memory.learned];
      const item = all.find((x) => x.id === id);
      if (!item) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Not found' })); }
      if (req.method === 'PATCH') {
        if (typeof body.text === 'string' && body.text.trim()) item.text = body.text.trim();
        if (Array.isArray(body.tags)) item.tags = body.tags;
        if (typeof body.enabled === 'boolean') item.enabled = body.enabled;
        if (typeof body.global === 'boolean') item.global = body.global;
        item.updatedAt = now();
        persistMemory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(item));
      }
      if (req.method === 'DELETE') {
        memory.notes = memory.notes.filter((x) => x.id !== id);
        memory.learned = memory.learned.filter((x) => x.id !== id);
        persistMemory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
    }
    if (p === '/api/memory/extract' && req.method === 'POST') return extractFacts(req, res, body);

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Internal error' }));
  }
}

// ------------------------------------------------------------- server ------

let server = null;
const connSockets = new Set();
let bindRetries = 0;
function startServer() {
  server = http.createServer(handle);
  server.on('connection', (s) => { connSockets.add(s); s.on('close', () => connSockets.delete(s)); });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      bindRetries++;
      if (bindRetries > 10) { console.error(`❌ Port ${config.port} is still in use. Give up — pick another port.`); process.exit(1); }
      console.error(`❌ Port ${config.port} is already in use. Waiting 1s and retrying…`);
      setTimeout(startServer, 1000);
      return;
    }
    throw err;
  });
  server.listen(config.port, config.host, () => {
    bindRetries = 0;
    const lan = isLoopback(config.host);
    const ip = lan ? null : lanIp();

    console.log('');
    console.log('  Ollama GUI is running');
    console.log(`  ● Local:    http://127.0.0.1:${config.port}`);
    if (!lan && ip) console.log(`  ● Network:  http://${ip}:${config.port}`);
    console.log(`  ◉ Ollama:   ${config.ollamaBase}`);
    if (!lan && config.accessToken) console.log(`  🔑 Token required (set in Settings or ?token=)`);
    else if (!lan && !config.accessToken) console.log('  ⚠  Bound to LAN with NO token. Set one in Settings → Access token.');
    console.log('');
  });
}
function restartServer() {
  const old = server;
  let done = false;
  const rebind = () => {
    if (done) return;
    done = true;
    try { startServer(); } catch (e) { console.error('Restart failed:', e.message); }
  };
  if (old) {
    // Drop keep-alive connections so close() completes promptly, then rebind.
    for (const sock of connSockets) sock.destroy();
    old.closeAllConnections?.();
    old.close(rebind);
    setTimeout(rebind, 1200); // watchdog
  } else {
    rebind();
  }
}

startServer();