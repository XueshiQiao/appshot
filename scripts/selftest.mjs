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

  // This audit only understands `flags.name` and `flags['name']`. If the source
  // ever reads flags another way, the audit would quietly stop covering it and
  // report success — the same silent-drift failure it exists to prevent. So it
  // refuses to run instead. Reads only: the assignments inside parseArgs use a
  // variable subscript legitimately.
  const parseArgsBody = /function parseArgs[\s\S]*?\n}/.exec(src)?.[0] ?? '';
  const elsewhere = src.replace(parseArgsBody, '');
  const opaque = [
    [/\}\s*=\s*flags\b/, 'destructuring from flags'],
    [/flags\[(?!')[^\]]+\]/, 'computed flags[...] access'],
  ].filter(([re]) => re.test(elsewhere));

  if (opaque.length) {
    fail(
      'flag reads are all in a form this audit understands',
      `found ${opaque.map(([, what]) => what).join(' and ')} — extend auditFlags() ` +
        `in scripts/selftest.mjs before trusting this check again`
    );
  } else {
    pass('flag reads are all in a form this audit understands');
  }

  // The regex above only sees reads spelled `flags.…`. A helper that receives
  // the flag object under a different parameter name is therefore invisible to
  // it — and worse, its reads then look like unused declarations, so the audit
  // fails for the wrong reason while missing the real problem. Rather than try
  // to follow renames, require that every function handed the flag object calls
  // its parameter `flags`, which is what makes the regex sufficient.
  // Look at every call that receives the flag object in ANY argument position,
  // whatever the callee looks like. An earlier version only checked the first
  // argument of plain `function` declarations, which missed both an arrow
  // function assigned to a const and `helper(other, flags)`.
  const bareFlags = /\bflags\b(?![.[])/;              // `flags`, not `flags.x`
  const suspects = new Map();                          // callee -> reason it fails

  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
    const [, name, args] = m;
    if (name === 'function' || !bareFlags.test(args)) continue;

    const decl = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`).exec(src);
    if (!decl) {
      suspects.set(
        name,
        `${name}() is not a plain function declaration (arrow, method or imported), ` +
          `so this audit cannot see what it names the parameter`
      );
    } else if (!bareFlags.test(decl[1])) {
      suspects.set(
        name,
        `${name}() receives the flag object but declares its parameters as ` +
          `(${decl[1].trim()}) — reads inside it are invisible to this audit`
      );
    }
  }

  suspects.size
    ? fail(
        'everything handed the flag object names the parameter "flags"',
        [...suspects.values()].join('\n') + '\n(rename the parameter to "flags")'
      )
    : pass('everything handed the flag object names the parameter "flags"');

  // The check above recognises the flag object by the literal token `flags` at
  // the call site, so ANY indirection defeats it: alias it to another name,
  // spread it, wrap it in an object, and the call becomes invisible again.
  // A regex cannot follow that — real data flow needs an AST. What it CAN do is
  // refuse to let the indirection happen quietly, so each known escape route is
  // a loud failure rather than a silent blind spot.
  const known = /const\s*\{\s*flags,\s*positional\s*\}\s*=\s*parseArgs\([^)]*\);?/g;
  const scan = elsewhere.replace(known, '');
  const indirection = [
    [/=\s*flags\b(?![.[])/, 'flags aliased to another variable'],
    [/\.\.\.\s*flags\b/, 'flags spread into something else'],
    [/\bflags\s*\.\s*bind\b/, 'flags bound to a function'],
    [/[[{]\s*flags\s*[,\]}]/, 'flags wrapped in an object or array'],
  ].filter(([re]) => re.test(scan));

  indirection.length
    ? fail(
        'the flag object reaches helpers directly, without indirection',
        `${indirection.map(([, what]) => what).join('; ')} — the audit tracks the ` +
          `literal token "flags", so this hides reads from it. Pass flags directly, ` +
          `or replace this audit with an AST-based one.`
      )
    : pass('the flag object reaches helpers directly, without indirection');

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
    // -o must not swallow a flag as its path and silently drop it.
    [['shot', '--bundle', 'com.apple.finder', '-o', '--activate'], '-o needs a path'],
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
