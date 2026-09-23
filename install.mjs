#!/usr/bin/env node
// Installs or upgrades the QA agent framework into a target repository.
// Usage: node install.mjs <target-repo-path> [--dry-run]
//
// Framework-owned files (overwritten on upgrade):
//   .claude/qa/**, .claude/skills/qa-*/**, .claude/agents/qa-*.md, .claude/commands/qa-*.md
// Merged (never overwritten): .claude/settings.json (permissions + guard hook)
// Never touched: .claude/skills/pack-*, qa.config.json, .qa/, CLAUDE.md, .mcp.json (handled by /qa-init)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '.claude');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const targetArg = argv.find((a) => !a.startsWith('--'));
if (!targetArg) {
  console.error('Usage: node install.mjs <target-repo-path> [--dry-run]');
  process.exit(1);
}
const TARGET = path.resolve(targetArg);
if (!fs.existsSync(TARGET)) { console.error(`Target not found: ${TARGET}`); process.exit(1); }
if (path.resolve(TARGET) === path.resolve(SRC, '..')) { console.error('Target is the framework repo itself.'); process.exit(1); }
const DEST = path.join(TARGET, '.claude');

const actions = [];
function copyDir(from, to, filter = () => true) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (filter(e.name)) {
      const exists = fs.existsSync(d);
      if (exists && fs.readFileSync(s).equals(fs.readFileSync(d))) continue;
      actions.push(`${exists ? 'update' : 'add   '} ${path.relative(TARGET, d)}`);
      if (!DRY) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
    }
  }
}

// 1. Framework-owned files
copyDir(path.join(SRC, 'qa'), path.join(DEST, 'qa'));
for (const dir of fs.readdirSync(path.join(SRC, 'skills'))) {
  if (dir.startsWith('qa-')) copyDir(path.join(SRC, 'skills', dir), path.join(DEST, 'skills', dir));
}
for (const sub of ['agents', 'commands']) {
  copyDir(path.join(SRC, sub), path.join(DEST, sub), (n) => n.startsWith('qa-'));
}

// 2. Merge settings.json
const srcSettings = JSON.parse(fs.readFileSync(path.join(SRC, 'settings.json'), 'utf8'));
const destSettingsFile = path.join(DEST, 'settings.json');
let dest = {};
if (fs.existsSync(destSettingsFile)) {
  try { dest = JSON.parse(fs.readFileSync(destSettingsFile, 'utf8')); }
  catch { console.error(`Cannot parse ${destSettingsFile}. Merge .claude/settings.json manually.`); process.exit(1); }
}
const before = JSON.stringify(dest);
dest.permissions ??= {};
dest.permissions.allow = [...new Set([...(dest.permissions.allow || []), ...srcSettings.permissions.allow])];
dest.hooks ??= {};
dest.hooks.PreToolUse ??= [];
const guardEntry = dest.hooks.PreToolUse.find((h) => (h.hooks || []).some((x) => String(x.command).includes('qa/scripts/guard.mjs')));
const hasGuard = Boolean(guardEntry);
if (!hasGuard) dest.hooks.PreToolUse.push(...srcSettings.hooks.PreToolUse);
else guardEntry.matcher = srcSettings.hooks.PreToolUse[0].matcher; // keep the guard's matcher current on upgrade
if (JSON.stringify(dest) !== before) {
  actions.push(`merge  ${path.relative(TARGET, destSettingsFile)} (permissions${hasGuard ? '' : ' + guard hook'})`);
  if (!DRY) { fs.mkdirSync(DEST, { recursive: true }); fs.writeFileSync(destSettingsFile, JSON.stringify(dest, null, 2) + '\n'); }
}

const version = fs.readFileSync(path.join(SRC, 'qa', 'VERSION'), 'utf8').trim();
console.log(`QA agent framework v${version} → ${TARGET}${DRY ? '  (dry run)' : ''}`);
console.log(actions.length ? actions.map((a) => '  ' + a).join('\n') : '  already up to date');
console.log(`
Next:
  1. Open the target repo in Claude Code (restart it if it was already open).
  2. Run /qa-init to detect the stack and create qa.config.json.
  3. Run /qa-new-pack <name> to capture your product knowledge.`);
