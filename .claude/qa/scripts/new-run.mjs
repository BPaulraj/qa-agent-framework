#!/usr/bin/env node
// Creates a run folder with a skeleton run.json and prints its id and paths.
// Usage: node .claude/qa/scripts/new-run.mjs [--env qa] [--name "Checkout regression"] [--trigger manual|regression|pr|ci] [--build 1.4.2]
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, loadConfig, parseArgs, writeJson, fail, out } from './lib/common.mjs';

const args = parseArgs();
const cfg = loadConfig();
const env = args.env || cfg.defaultEnvironment;
if (!cfg.environments?.[env]) fail(`Unknown environment "${env}". Defined: ${Object.keys(cfg.environments || {}).join(', ')}`);
if (cfg.environments[env].blocked) fail(`Environment "${env}" is blocked in qa.config.json.`);

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const runId = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${env}`;
const dir = path.join(repoRoot(), cfg.paths.runs, runId);
fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
fs.mkdirSync(path.join(dir, 'defects'), { recursive: true });
writeJson(path.join(dir, 'run.json'), {
  runId,
  name: args.name || `Run ${runId}`,
  trigger: args.trigger || 'manual',
  environment: env,
  build: args.build || '',
  startedAt: d.toISOString(),
  finishedAt: '',
  results: [],
});
out({ runId, dir: path.relative(repoRoot(), dir).split(path.sep).join('/'), environment: env, ...cfg.environments[env] });
