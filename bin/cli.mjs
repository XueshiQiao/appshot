#!/usr/bin/env node
// Entry point for `npx github:XueshiQiao/appshot`.
//
// With no arguments (or `install`) this installs the skill. Anything else is
// forwarded straight to the capture CLI, so the tool can be tried out without
// installing it first:  npx github:XueshiQiao/appshot list --app Finder

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKILL_NAME = 'appshot';

// Every agent that reads Anthropic-style skills, keyed by the flag that picks it.
const TARGETS = {
  claude: { label: 'Claude Code (user)', dir: join(homedir(), '.claude', 'skills') },
  project: { label: 'Claude Code (this project)', dir: join(process.cwd(), '.claude', 'skills') },
  codex: { label: 'Codex', dir: join(homedir(), '.codex', 'skills') },
};

// package.json travels with the skill so the installed copy can report which
// version it is. Without it there is no way to tell an old install from a new one.
const FILES = ['SKILL.md', 'scripts', 'README.md', 'LICENSE', 'package.json'];

const USAGE = `appshot — screenshot a specific macOS app window

Install the skill:
  npx github:XueshiQiao/appshot                 → ~/.claude/skills/appshot
  npx github:XueshiQiao/appshot --project       → ./.claude/skills/appshot
  npx github:XueshiQiao/appshot --codex         → ~/.codex/skills/appshot
  npx github:XueshiQiao/appshot --dir <path>    → anywhere you like

Try it without installing:
  npx github:XueshiQiao/appshot list --app Finder
  npx github:XueshiQiao/appshot shot --bundle com.apple.finder -o /tmp/f.png

Reinstalling replaces an existing appshot install. If the destination exists but
is not an appshot install, it is left alone unless you pass --force.`;

function installTargets(argv) {
  const custom = argv.indexOf('--dir');
  if (custom !== -1) {
    const p = argv[custom + 1];
    if (!p) fail('--dir needs a path');
    return [{ label: 'custom', dir: resolve(p) }];
  }
  const picked = Object.entries(TARGETS)
    .filter(([key]) => argv.includes(`--${key}`))
    .map(([, t]) => t);
  return picked.length ? picked : [TARGETS.claude];
}

function fail(msg) {
  console.error(`appshot: ${msg}`);
  process.exit(1);
}

// Only a directory that is recognisably a previous appshot install may be
// deleted. `--dir` accepts any path, so without this check reinstalling into a
// folder that happens to be named "appshot" would recursively delete somebody's
// unrelated work with nothing but a log line.
function looksLikeAppshotInstall(dest) {
  const skill = join(dest, 'SKILL.md');
  if (!existsSync(skill)) return false;
  try {
    return /^name:\s*appshot\s*$/m.test(readFileSync(skill, 'utf8'));
  } catch {
    return false;
  }
}

function install(argv) {
  const force = argv.includes('--force');
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  } catch { /* not fatal */ }

  for (const target of installTargets(argv)) {
    const dest = join(target.dir, SKILL_NAME);

    if (existsSync(dest)) {
      if (!looksLikeAppshotInstall(dest) && !force) {
        fail(
          `${dest} already exists and does not look like an appshot install.\n` +
            `Refusing to delete it. Move it aside, or pass --force to overwrite it anyway.`
        );
      }
      rmSync(dest, { recursive: true, force: true });
    }
    mkdirSync(dest, { recursive: true });

    for (const f of FILES) {
      const from = join(ROOT, f);
      if (existsSync(from)) cpSync(from, join(dest, f), { recursive: true });
    }
    console.log(`✓ installed appshot ${version} → ${dest}  (${target.label})`);
  }

  console.log(`
Next: start a new session so the agent picks the skill up, then just ask —
  "screenshot PastePaw's settings window"

macOS needs Screen & System Audio Recording permission for your terminal, and
Accessibility permission as well if you want the --hotkey feature.`);
}

// Only these mean "install". Routing on a bare leading "--" used to send a
// mistyped capture command (appshot --bundle com.foo, subcommand forgotten)
// into the installer, which then deleted and rewrote the installed skill.
const INSTALL_FLAGS = new Set([
  '--force', '--dir', '--claude', '--project', '--codex',
]);

const argv = process.argv.slice(2);
const first = argv[0];

if (first === '--help' || first === '-h') {
  console.log(USAGE);
} else if (first === undefined || first === 'install' || INSTALL_FLAGS.has(first)) {
  install(argv);
} else if (first.startsWith('-')) {
  console.error(`appshot: unknown option "${first}"\n\n${USAGE}`);
  process.exit(1);
} else {
  const { main } = await import(join(ROOT, 'scripts', 'appshot.mjs'));
  main(argv).catch((err) => {
    console.error(String(err.message || err));
    process.exit(1);
  });
}
