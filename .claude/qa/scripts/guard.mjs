#!/usr/bin/env node
// PreToolUse hook: enforces qa.config.json guardrails.
//  - deny any tool call that targets a blocked environment / blocked host
//  - deny HTTP write calls (curl/Invoke-RestMethod/etc.) against environments with allowWrite:false
//  - deny tool calls that contain the literal value of the ADO PAT or any environment auth secret
// Fails open (allows) on internal errors so a bug here never bricks the session; the reason goes to stderr.
import { loadConfig } from './lib/common.mjs';

const readStdin = () => new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => resolve(data));
});

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[qa-guard] ${reason}` },
  }));
  process.exit(0);
};

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
const hostGlob = (glob, host) => {
  const g = glob.toLowerCase();
  const re = new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*(?:\\.[^.]*)*?') + '$');
  return re.test(host) || (g.startsWith('*.') && host === g.slice(2));
};

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const cfg = loadConfig({ required: false });
  if (!cfg) process.exit(0);

  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const blob = JSON.stringify(ti);
  const urls = [...blob.matchAll(/https?:\/\/[^\s"'`<>)\\]+/g)].map((m) => m[0]);
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];

  const envs = Object.entries(cfg.environments || {});
  const envHosts = (env) => [env.webBaseUrl, env.apiBaseUrl].map(hostOf).filter(Boolean);

  // 1. Blocked hosts / environments
  const blockedGlobs = [...(cfg.guardrails?.blockedHosts || [])];
  for (const [, env] of envs) if (env.blocked) blockedGlobs.push(...envHosts(env));
  for (const h of hosts) {
    const hit = blockedGlobs.find((g) => hostGlob(g, h));
    if (hit) deny(`"${h}" matches blocked host/environment "${hit}" in qa.config.json. Testing against it is not allowed.`);
  }

  // 2. Writes against read-only environments (shell HTTP clients)
  const isShell = /^(Bash|PowerShell)$/.test(tool);
  if (isShell && typeof ti.command === 'string') {
    const cmd = ti.command;
    const writeVerb = /(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b|\s(-d|--data(-raw|-binary|-urlencode)?|-F|--form)\s|-Method\s+['"]?(Post|Put|Patch|Delete)\b|\bhttp[ie]?\s+(POST|PUT|PATCH|DELETE)\b/i;
    if (writeVerb.test(cmd)) {
      for (const [name, env] of envs) {
        if (env.allowWrite === false && envHosts(env).some((h) => hosts.includes(h))) {
          deny(`Environment "${name}" is read-only (allowWrite:false). Write request blocked.`);
        }
      }
    }
  }

  // 3. Literal secrets
  const secretVars = new Set([cfg.ado?.patEnvVar || 'AZURE_DEVOPS_EXT_PAT']);
  for (const [, env] of envs) for (const v of Object.values(env.auth || {})) secretVars.add(v);
  for (const v of secretVars) {
    const val = process.env[v];
    if (val && val.length >= 8 && blob.includes(val)) {
      deny(`Tool input contains the literal value of $${v}. Reference the environment variable instead of its value.`);
    }
  }
  process.exit(0);
} catch (e) {
  console.error(`[qa-guard] internal error, allowing: ${e.message}`);
  process.exit(0);
}
