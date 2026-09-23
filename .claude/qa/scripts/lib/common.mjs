// Shared helpers for QA framework scripts. Zero external dependencies (js-yaml is vendored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../vendor/js-yaml.mjs';

export const QA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repo root: CLAUDE_PROJECT_DIR if set, else the folder containing .claude/. */
export function repoRoot() {
  const p = process.env.CLAUDE_PROJECT_DIR ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : path.resolve(QA_DIR, '..', '..');
  try { return fs.realpathSync.native(p); } catch { return p; } // expands Windows 8.3 short names
}

export function loadConfig({ required = true } = {}) {
  const file = path.join(repoRoot(), 'qa.config.json');
  if (!fs.existsSync(file)) {
    if (required) fail(`qa.config.json not found at ${file}. Run /qa-init first.`);
    return null;
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.paths = { cases: '.qa/cases', runs: '.qa/runs', plans: '.qa/plans', ...(cfg.paths || {}) };
  return cfg;
}

export function readData(file) {
  const text = fs.readFileSync(file, 'utf8');
  return /\.ya?ml$/i.test(file) ? yaml.load(text) : JSON.parse(text);
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'target', 'dist', 'build', 'out',
  '.venv', 'venv', '__pycache__', '.next', '.idea', '.vs', 'coverage', 'playwright-report', 'test-results']);

/** Recursively list files under dir (relative paths, forward slashes). */
export function walk(dir, { maxDepth = 8, filter = () => true } = {}) {
  const out = [];
  const root = path.resolve(dir);
  (function rec(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) rec(full, depth + 1);
      } else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (filter(rel)) out.push(rel);
      }
    }
  })(root, 0);
  return out;
}

/** Convert a glob (supports **, *, ?) to a RegExp. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export const matchGlob = (glob, str) => globToRegExp(glob).test(str);

/** Load all test cases from the cases folder: [{ file, case }]. */
export function loadCases(cfg) {
  const dir = path.join(repoRoot(), cfg.paths.cases);
  if (!fs.existsSync(dir)) return [];
  return walk(dir, { filter: (f) => /\.(ya?ml|json)$/i.test(f) }).map((rel) => {
    const file = path.join(dir, rel);
    try {
      return { file, case: readData(file) };
    } catch (e) {
      return { file, error: e.message };
    }
  });
}

/** Minimal argv parser: --flag, --key value, --key=value, positionals. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

export function fail(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

export const out = (data) => console.log(JSON.stringify(data, null, 2));
