// Agent Workspace — local-side handlers for agent file/shell/browser tools.
// Reads agent_* commands from pending_commands and executes them on the user's PC.
//
// Workspace lives at: <server/data/agent-workspace>/<projectSlug>/...
// Each agent run gets its own subfolder so projects don't collide.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const url = require('url');

const DEFAULT_WORKSPACE_ROOT = path.join(__dirname, 'data', 'agent-workspace');
const ALLOWED_SHELL = ['npm', 'npx', 'node', 'python', 'python3', 'git', 'dir', 'ls', 'echo', 'type', 'cat'];

function getWorkspaceRoot(workspaceRoot) {
  const raw = String(workspaceRoot || '').trim();
  return raw ? path.resolve(raw) : DEFAULT_WORKSPACE_ROOT;
}

function ensureRoot(workspaceRoot) {
  const root = getWorkspaceRoot(workspaceRoot);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function projectDir(slug, workspaceRoot) {
  const root = ensureRoot(workspaceRoot);
  const safe = String(slug || 'task').replace(/[^a-z0-9_-]/gi, '-').slice(0, 60) || 'task';
  const dir = path.join(root, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeJoin(slug, rel, workspaceRoot) {
  const base = projectDir(slug, workspaceRoot);
  const target = path.resolve(base, rel || '.');
  if (!target.startsWith(base)) throw new Error('Path escapes workspace');
  return target;
}

/* ── Static preview server (single shared HTTP server, projects served by slug) ── */
const previewServers = new Map();
let previewPortCounter = 3010;

function startPreviewServer(workspaceRoot) {
  const root = ensureRoot(workspaceRoot);
  const existing = previewServers.get(root);
  if (existing) return existing.port;

  const port = previewPortCounter++;
  const previewServer = http.createServer((req, res) => {
    try {
      const u = url.parse(req.url);
      // Path format: /<slug>/<file...>
      const parts = (u.pathname || '/').split('/').filter(Boolean);
      if (parts.length === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const projects = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory());
        res.end(`<h1>Agent Workspace</h1><ul>${projects.map((p) => `<li><a href="/${p}/">${p}</a></li>`).join('')}</ul>`);
        return;
      }
      const slug = parts[0];
      const rel = parts.slice(1).join('/') || 'index.html';
      const filePath = safeJoin(slug, rel, root);
      if (!fs.existsSync(filePath)) {
        // Try directory index
        const idx = path.join(filePath, 'index.html');
        if (fs.existsSync(idx)) return sendFile(res, idx);
        res.writeHead(404); res.end('Not found'); return;
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        const idx = path.join(filePath, 'index.html');
        if (fs.existsSync(idx)) return sendFile(res, idx);
        res.writeHead(404); res.end('No index.html'); return;
      }
      sendFile(res, filePath);
    } catch (e) {
      res.writeHead(500); res.end(String(e.message || e));
    }
  });
  previewServer.listen(port, () => {
    console.log(`[AgentWorkspace] Preview server on http://localhost:${port}`);
  });
  previewServers.set(root, { server: previewServer, port });
  return port;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif',
    '.webp': 'image/webp', '.txt': 'text/plain',
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

/* ── Tool implementations ─────────────────────────────────────────── */

async function writeFile({ projectSlug, path: rel, content, workspaceRoot }) {
  const target = safeJoin(projectSlug, rel, workspaceRoot);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content ?? '', 'utf8');
  const size = Buffer.byteLength(content ?? '', 'utf8');
  return { path: target, size, message: `Wrote ${rel} (${size} bytes)` };
}

async function readFile({ projectSlug, path: rel, workspaceRoot }) {
  const target = safeJoin(projectSlug, rel, workspaceRoot);
  const content = await fsp.readFile(target, 'utf8');
  return { path: target, content: content.slice(0, 20000) };
}

async function listFiles({ projectSlug, workspaceRoot }) {
  const base = projectDir(projectSlug, workspaceRoot);
  const files = [];
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else files.push({ path: rel, size: stat.size });
    }
  }
  walk(base);
  return { workspace: base, files };
}

function runShell({ projectSlug, command, timeout_seconds, workspaceRoot }) {
  return new Promise((resolve) => {
    const cwd = projectDir(projectSlug, workspaceRoot);
    const first = String(command).trim().split(/\s+/)[0]?.toLowerCase();
    if (!ALLOWED_SHELL.includes(first)) {
      return resolve({ ok: false, error: `Command "${first}" not allowed. Allowed: ${ALLOWED_SHELL.join(', ')}` });
    }
    const timeoutMs = Math.min(Math.max(Number(timeout_seconds) || 60, 5), 300) * 1000;
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err ? err.code : 0,
        stdout: (stdout || '').slice(-4000),
        stderr: (stderr || '').slice(-2000),
        cwd,
      });
    });
  });
}

async function openInBrowser({ projectSlug, target, workspaceRoot }) {
  let toOpen = target;
  // If it doesn't look like a URL, treat as workspace-relative file path
  if (!/^https?:\/\//i.test(target)) {
    // If preview server running, prefer URL
    const port = startPreviewServer(workspaceRoot);
    toOpen = `http://localhost:${port}/${projectSlug}/${target.replace(/^\/+/, '')}`;
  }
  return new Promise((resolve) => {
    const platform = process.platform;
    const cmd = platform === 'win32' ? `start "" "${toOpen}"`
      : platform === 'darwin' ? `open "${toOpen}"`
      : `xdg-open "${toOpen}"`;
    exec(cmd, { windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: err.message, opened: toOpen });
      else resolve({ ok: true, opened: toOpen });
    });
  });
}

async function servePreview({ projectSlug, workspaceRoot }) {
  const port = startPreviewServer(workspaceRoot);
  const previewUrl = `http://localhost:${port}/${projectSlug}/`;
  return { ok: true, url: previewUrl, message: `Preview running at ${previewUrl}` };
}

/* ── Dispatcher (called from server/index.js command poller) ──────── */

async function handleAgentCommand(command, args) {
  switch (command) {
    case 'agent_write_file':    return await writeFile(args);
    case 'agent_read_file':     return await readFile(args);
    case 'agent_list_files':    return await listFiles(args);
    case 'agent_run_shell':     return await runShell(args);
    case 'agent_open_in_browser': return await openInBrowser(args);
    case 'agent_serve_preview': return await servePreview(args);
    default: throw new Error(`Unknown agent command: ${command}`);
  }
}

module.exports = {
  handleAgentCommand,
  WORKSPACE_ROOT: DEFAULT_WORKSPACE_ROOT,
  projectDir,
  startPreviewServer,
};
