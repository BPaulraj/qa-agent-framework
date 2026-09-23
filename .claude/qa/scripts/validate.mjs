#!/usr/bin/env node
// Validates qa.config.json, test cases, run.json and defect drafts against the framework schemas.
// Usage:
//   node .claude/qa/scripts/validate.mjs                 # config + all cases
//   node .claude/qa/scripts/validate.mjs path/to/file... # specific files (schema inferred from path)
// Also checks: duplicate case ids, module/journey keys unknown to enabled packs.
import fs from 'node:fs';
import path from 'node:path';
import { QA_DIR, repoRoot, loadConfig, loadCases, readData, parseArgs, out } from './lib/common.mjs';

const schemas = Object.fromEntries(['qa.config', 'testcase', 'run', 'defect', 'module-map'].map((n) =>
  [n, JSON.parse(fs.readFileSync(path.join(QA_DIR, 'schemas', `${n}.schema.json`), 'utf8'))]));

// Minimal draft-07 subset: type, required, properties, additionalProperties(schema), items, enum,
// pattern, minItems, minLength, minProperties, $ref (#/definitions/...).
function validate(schema, value, root = schema, at = '$', errors = []) {
  if (schema.$ref) return validate(schema.$ref.replace('#/', '').split('/').reduce((o, k) => o[k], root), value, root, at, errors);
  const t = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
  if (schema.type) {
    const allowed = [].concat(schema.type);
    if (!allowed.includes(t) && !(t === 'integer' && allowed.includes('number'))) {
      errors.push(`${at}: expected ${allowed.join('|')}, got ${t}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: "${value}" not one of ${schema.enum.join(', ')}`);
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: "${value}" does not match ${schema.pattern}`);
  if (schema.minLength && typeof value === 'string' && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  if (t === 'array') {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, root, `${at}[${i}]`, errors));
  }
  if (t === 'object') {
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${at}: missing required "${r}"`);
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) errors.push(`${at}: needs at least ${schema.minProperties} entr(y/ies)`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, root, `${at}.${k}`, errors);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, root, `${at}.${k}`, errors);
    }
  }
  return errors;
}

const root = repoRoot();
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const schemaFor = (f) => /qa\.config\.json$/.test(f) ? 'qa.config' : /module-map\.json$/.test(f) ? 'module-map' : /run\.json$/.test(f) ? 'run' : /[\\/]defects[\\/]/.test(f) ? 'defect' : 'testcase';

const report = [];
const args = parseArgs();
const cfg = loadConfig({ required: false });

let targets;
if (args._.length) targets = args._.map((f) => ({ file: path.resolve(f) }));
else {
  targets = [{ file: path.join(root, 'qa.config.json') }];
  const maps = [...(cfg?.packs || []).map((p) => path.join(root, '.claude/skills', p, 'module-map.json')), path.join(root, '.qa/module-map.json')];
  targets.push(...maps.filter((f) => fs.existsSync(f)).map((file) => ({ file })));
  if (cfg) targets.push(...loadCases(cfg));
}

// Known module/journey keys from enabled packs and the repo map, for cross-reference warnings
const knownModules = new Set();
const knownJourneys = new Set();
for (const f of [...(cfg?.packs || []).map((p) => path.join(root, '.claude/skills', p, 'module-map.json')), path.join(root, '.qa/module-map.json')]) {
  if (fs.existsSync(f)) for (const [k, m] of Object.entries(readData(f).modules || {})) {
    knownModules.add(k);
    (m.journeys || []).forEach((j) => knownJourneys.add(j));
  }
}
for (const pack of cfg?.packs || []) {
  if (cfg && !fs.existsSync(path.join(root, '.claude/skills', pack, 'SKILL.md'))) {
    report.push({ file: 'qa.config.json', errors: [`pack "${pack}" listed but .claude/skills/${pack}/SKILL.md not found`] });
  }
}

const ids = new Map();
for (const t of targets) {
  if (!fs.existsSync(t.file)) { report.push({ file: rel(t.file), errors: ['file not found'] }); continue; }
  let data = t.case;
  if (!data) {
    try { data = readData(t.file); } catch (e) { report.push({ file: rel(t.file), errors: [`parse error: ${e.message}`] }); continue; }
  }
  const kind = schemaFor(t.file);
  const errors = validate(schemas[kind], data);
  const warnings = [];
  if (kind === 'testcase' && data) {
    if (ids.has(data.id)) errors.push(`duplicate id ${data.id} (also in ${ids.get(data.id)})`);
    else ids.set(data.id, rel(t.file));
    if (knownModules.size && data.module && !knownModules.has(data.module)) warnings.push(`module "${data.module}" not in any enabled pack's module-map.json`);
    if (knownJourneys.size && data.journey && !knownJourneys.has(data.journey)) warnings.push(`journey "${data.journey}" not in any module-map.json`);
    if ((data.steps || []).every((s) => !s.expected)) warnings.push('no step has an expected result');
    if (JSON.stringify(data).match(/password\s*[:=]\s*(?!\$\{)[^\s,"]{3,}/i)) warnings.push('looks like a literal password; use ${ENV_VAR}');
  }
  if (errors.length || warnings.length) report.push({ file: rel(t.file), schema: kind, errors, warnings });
}

const errorCount = report.reduce((n, r) => n + (r.errors?.length || 0), 0);
out({ checked: targets.length, errorCount, warningCount: report.reduce((n, r) => n + (r.warnings?.length || 0), 0), issues: report });
process.exit(errorCount ? 1 : 0);
