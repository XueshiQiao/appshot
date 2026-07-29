#!/usr/bin/env node
// appshot self-test — run with: node scripts/selftest.mjs
//
// Exists because a hand-maintained flag whitelist shipped with `--window`
// missing, which broke the main preview-then-capture path while every other
// command still passed. Anything a human has to keep in sync gets checked here.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexecFile = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'appshot.mjs');

let failures = 0;
const pass = (name) => console.log(`  ok    ${name}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  FAIL  ${name}\n        ${String(detail).split('\n').join('\n        ')}`);
};

async function run(args) {
  try {
    const { stdout } = await pexecFile('node', [CLI, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

/* 1 — every flag the source reads must be declared in exactly one whitelist. */
function auditFlags() {
  console.log('\nflag whitelists');
  const src = readFileSync(CLI, 'utf8');
  const setOf = (name) => {
    const block = new RegExp(`${name} = new Set\\(\\[(.*?)\\]\\)`, 's').exec(src);
    if (!block) throw new Error(`could not find ${name} in the source`);
    return new Set([...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
  };

  const declared = new Set([...setOf('BOOLEAN_FLAGS'), ...setOf('VALUE_FLAGS')]);
  const used = new Set(
    [...src.matchAll(/flags\.([a-zA-Z]+)|flags\['([a-z-]+)'\]/g)].map((m) => m[1] || m[2])
  );

  const undeclared = [...used].filter((f) => !declared.has(f)).sort();
  const unused = [...declared].filter((f) => !used.has(f)).sort();

  undeclared.length
    ? fail('every flag used is declared', `used but not declared: ${undeclared.join(', ')}`)
    : pass('every flag used is declared');
  unused.length
    ? fail('no stale declarations', `declared but never read: ${unused.join(', ')}`)
    : pass('no stale declarations');
}

/* 2 — commands that must succeed, including the ones a regression would skip. */
async function smokeOk() {
  console.log('\ncommands that must succeed');

  const listed = await run(['list', '--onscreen']);
  let anyWindowId = null;
  try {
    anyWindowId = JSON.parse(listed.stdout)[0]?.id ?? null;
  } catch { /* reported below */ }

  const cases = [
    ['version'],
    ['help'],
    ['apps'],
    ['list', '--onscreen'],
    ['list', '--all'],
    // Single-dash values must survive: a display left of the primary one has
    // negative coordinates, and this silently captured the whole screen before.
    ['screen', '--rect', '-10,0,120,90', '--max', '80', '-o', '/tmp/appshot-selftest-rect.png'],
  ];
  if (anyWindowId !== null) {
    // The path that shipped broken: preview hands back ids, shot takes one.
    cases.push(['shot', '--window', String(anyWindowId), '--max', '120',
      '-o', '/tmp/appshot-selftest-win.png']);
  }

  for (const args of cases) {
    const r = await run(args);
    const label = args.join(' ');
    if (r.code !== 0) { fail(label, r.stdout || r.stderr); continue; }
    if (args[0] !== 'help' && !/"ok"|\[|\{/.test(r.stdout)) {
      fail(label, `unexpected output: ${r.stdout.slice(0, 200)}`);
      continue;
    }
    pass(label);
  }

  if (anyWindowId === null) {
    console.log('  note  no on-screen window found, skipped the --window case');
  }
}

/* 3 — bad input must fail loudly rather than doing something surprising. */
async function smokeErrors() {
  console.log('\nbad input must be rejected');
  const cases = [
    [['shot'], 'need --bundle'],
    [['shot', '--bundle'], 'needs a value'],
    [['list', '-onscreen'], 'unknown flag'],
    [['list', '--bogus'], 'unknown flag'],
    [['frobnicate'], 'unknown command'],
  ];
  for (const [args, expect] of cases) {
    const r = await run(args);
    const label = args.join(' ') || '(no args)';
    const text = r.stdout + (r.stderr || '');
    if (r.code === 0) fail(label, `expected failure, got exit 0: ${text.slice(0, 160)}`);
    else if (!text.includes(expect)) fail(label, `expected "${expect}", got: ${text.slice(0, 160)}`);
    else pass(`${label}  →  ${expect}`);
  }
}

auditFlags();
await smokeOk();
await smokeErrors();

console.log(failures ? `\n${failures} failure(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
