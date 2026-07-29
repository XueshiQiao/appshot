#!/usr/bin/env node
// appshot — capture a specific macOS app window by bundle id, title, or window id.
// Zero dependencies. Uses screencapture(1), sips(1) and JXA (osascript -l JavaScript).

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexecFile = promisify(execFile);

// package.json is the single place the version is written; the installer copies
// it alongside this script so an installed skill can still answer `version`.
function readVersion() {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ------------------------------------------------------------------ *
 * JXA bridge
 * ------------------------------------------------------------------ */

// Runs a JavaScript-for-Automation snippet and parses whatever it printed.
// The snippet goes in over stdin, so its size is not bounded by ARG_MAX and no
// shell ever sees it. execFile has no `input` option, hence the manual spawn.
const JXA_TIMEOUT_MS = 15000;

function jxa(script) {
  return new Promise((resolve_, reject) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`osascript timed out after ${JXA_TIMEOUT_MS}ms`));
    }, JXA_TIMEOUT_MS);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve_(value);
    };

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(new Error(`could not run osascript: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(new Error(`osascript exited ${code}: ${stderr.trim() || '(no output)'}`));
      }
      const text = stdout.trim();
      if (!text) return finish(null, null);
      try {
        finish(null, JSON.parse(text));
      } catch {
        finish(new Error(`osascript returned non-JSON output:\n${text}`));
      }
    });

    child.stdin.on('error', () => { /* closed early; `close` reports the real reason */ });
    child.stdin.end(script);
  });
}

const JXA_WINDOWS = `
ObjC.import('Cocoa');
ObjC.import('CoreGraphics');

function bundleFor(pid, cache) {
  if (cache[pid] !== undefined) return cache[pid];
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  var out = null;
  if (app && !app.isNil()) {
    var bid = app.bundleIdentifier;
    out = (bid && !bid.isNil()) ? ObjC.unwrap(bid) : null;
  }
  cache[pid] = out;
  return out;
}

// The token below is substituted by the caller: onscreen-only, or every window.
var ref = $.CGWindowListCopyWindowInfo(__LIST_OPTION__, $.kCGNullWindowID);
var raw = ObjC.deepUnwrap(ObjC.castRefToObject(ref));
var cache = {};
var out = [];
for (var i = 0; i < raw.length; i++) {
  var w = raw[i];
  var b = w.kCGWindowBounds || {};
  var pid = w.kCGWindowOwnerPID;
  out.push({
    id: w.kCGWindowNumber,
    title: w.kCGWindowName || '',
    app: w.kCGWindowOwnerName || '',
    bundleId: bundleFor(pid, cache),
    pid: pid,
    x: Math.round(b.X || 0),
    y: Math.round(b.Y || 0),
    width: Math.round(b.Width || 0),
    height: Math.round(b.Height || 0),
    layer: w.kCGWindowLayer,
    onScreen: !!w.kCGWindowIsOnscreen,
    alpha: w.kCGWindowAlpha,
  });
}
JSON.stringify(out);
`;

const JXA_APPS = `
ObjC.import('Cocoa');
var apps = ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications);
var out = [];
for (var i = 0; i < apps.length; i++) {
  var a = apps[i];
  var bid = a.bundleIdentifier;
  if (!bid || bid.isNil()) continue;
  var policy = a.activationPolicy;   // 0 regular (Dock), 1 accessory (menu bar), 2 prohibited
  out.push({
    name: ObjC.unwrap(a.localizedName),
    bundleId: ObjC.unwrap(bid),
    pid: a.processIdentifier,
    kind: policy === 0 ? 'regular' : (policy === 1 ? 'menubar' : 'background'),
    active: !!a.isActive,
    hidden: !!a.isHidden,
  });
}
JSON.stringify(out);
`;

/**
 * `includeOffscreen` is the difference between "what the user can see" and
 * "every window that exists". It matters more than it sounds: a hidden or
 * off-screen window still keeps its rendered contents, and screencapture -l
 * captures those perfectly well — so off-screen windows are usually exactly
 * what a caller asking for one specific app wants.
 */
async function listWindowsRaw({ includeOffscreen = false } = {}) {
  const option = includeOffscreen
    ? '$.kCGWindowListOptionAll'
    : '($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements)';
  return (await jxa(JXA_WINDOWS.replaceAll('__LIST_OPTION__', option))) || [];
}

async function listApps() {
  return (await jxa(JXA_APPS)) || [];
}

/* ------------------------------------------------------------------ *
 * Window filtering / matching
 * ------------------------------------------------------------------ */

// Owners that only ever produce system chrome. They are never what a caller
// means by "capture this app", so they are dropped unless --all is passed.
const SYSTEM_OWNERS = new Set([
  'Window Server',
  'Dock',
  'Control Center',
  'Notification Center',
  'SystemUIServer',
  'Spotlight',
  'WindowManager',
]);

const MIN_SIDE = 40;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　_\-–—:：·.。,，'"“”‘’()（）\[\]]/g, '');
}

function filterWindows(windows, opts = {}) {
  const { bundleId, app, title, all = false, onscreen = false, minSide = MIN_SIDE } = opts;
  let out = windows;

  if (!all) {
    out = out.filter(
      (w) =>
        w.width >= minSide &&
        w.height >= minSide &&
        w.alpha > 0 &&
        w.layer >= 0 &&
        !SYSTEM_OWNERS.has(w.app)
    );
  }

  if (onscreen) out = out.filter((w) => w.onScreen);

  if (bundleId) {
    const want = String(bundleId).toLowerCase();
    out = out.filter((w) => (w.bundleId || '').toLowerCase() === want);
  }

  if (app) {
    const want = normalize(app);
    out = out.filter((w) => normalize(w.app).includes(want));
  }

  if (title) out = matchByTitle(out, title);

  // Most-likely-wanted first: real windows (layer 0) before floating panels,
  // visible before hidden, then larger before smaller.
  return out.slice().sort((a, b) => {
    if ((a.layer === 0) !== (b.layer === 0)) return a.layer === 0 ? -1 : 1;
    if (a.onScreen !== b.onScreen) return a.onScreen ? -1 : 1;
    return b.width * b.height - a.width * a.height;
  });
}

// Three passes, loosest last, so an exact title always beats a fuzzy hit.
function matchByTitle(windows, query) {
  const q = String(query);
  const exact = windows.filter((w) => w.title === q);
  if (exact.length) return exact;

  const ql = q.toLowerCase();
  const sub = windows.filter((w) => w.title.toLowerCase().includes(ql));
  if (sub.length) return sub;

  const qn = normalize(q);
  if (!qn) return [];
  return windows.filter((w) => normalize(w.title).includes(qn));
}

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

function defaultOutPath(tag) {
  const dir = join(tmpdir(), 'appshot');
  mkdirSync(dir, { recursive: true });
  // Milliseconds included: capturing the same window twice in one second is
  // ordinary (before/after a change), and second resolution silently overwrote
  // the first shot.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const safe = String(tag || 'window').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return join(dir, `${safe}-${stamp}.png`);
}

// A window that is not on screen has no fresh backing store, so screencapture
// hands back a blank frame instead of failing. Size is the only reliable tell.
const BLANK_PNG_BYTES = 6 * 1024;

async function captureWindow(windowId, outPath, { max = 1600, shadow = false } = {}) {
  mkdirSync(dirname(outPath), { recursive: true });
  const args = ['-x'];
  if (!shadow) args.push('-o');
  args.push('-l', String(windowId), outPath);

  try {
    await pexecFile('screencapture', args);
  } catch (err) {
    throw new Error(`screencapture failed for window ${windowId}: ${err.stderr || err.message}`);
  }
  if (!existsSync(outPath)) {
    throw new Error(
      `screencapture produced no file for window ${windowId}. ` +
        `The window id may be stale, or Screen Recording permission is missing ` +
        `(System Settings › Privacy & Security › Screen & System Audio Recording).`
    );
  }

  let bytes = statSync(outPath).size;
  const suspectBlank = bytes < BLANK_PNG_BYTES;

  let scaled = false;
  if (max > 0) {
    const dim = pngSize(outPath);
    if (dim && Math.max(dim.width, dim.height) > max) {
      await pexecFile('sips', ['-Z', String(max), outPath, '--out', outPath]);
      bytes = statSync(outPath).size;
      scaled = true;
    }
  }

  const dim = pngSize(outPath) || {};
  return { path: outPath, bytes, width: dim.width, height: dim.height, scaled, suspectBlank };
}

function pngSize(path) {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
      encoding: 'utf8',
    });
    const w = /pixelWidth:\s*(\d+)/.exec(out);
    const h = /pixelHeight:\s*(\d+)/.exec(out);
    if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  } catch {
    /* fall through */
  }
  return null;
}

async function captureScreen(outPath, { max = 1600, display = null, rect = null } = {}) {
  mkdirSync(dirname(outPath), { recursive: true });
  const args = ['-x'];
  if (display) args.push(`-D${display}`);
  if (rect) args.push(`-R${rect}`);
  args.push(outPath);
  await pexecFile('screencapture', args);

  let bytes = statSync(outPath).size;
  let scaled = false;
  if (max > 0) {
    const dim = pngSize(outPath);
    if (dim && Math.max(dim.width, dim.height) > max) {
      await pexecFile('sips', ['-Z', String(max), outPath, '--out', outPath]);
      bytes = statSync(outPath).size;
      scaled = true;
    }
  }
  const dim = pngSize(outPath) || {};
  return { path: outPath, bytes, width: dim.width, height: dim.height, scaled };
}

/* ------------------------------------------------------------------ *
 * Activation: launch, focus, and coax hidden windows into existence
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to let a freshly summoned window finish fading in.
const SETTLE_ALPHA = 0.95;
const SETTLE_POLL_MS = 120;
const SETTLE_TRIES = 12;

const KEY_CODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119,
  pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

const MODIFIERS = {
  cmd: 'command down', command: 'command down', '⌘': 'command down',
  shift: 'shift down', '⇧': 'shift down',
  ctrl: 'control down', control: 'control down', '⌃': 'control down',
  opt: 'option down', option: 'option down', alt: 'option down', '⌥': 'option down',
  fn: 'function down',
};

function parseHotkey(spec) {
  const parts = String(spec)
    .split(/[\s+]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('empty hotkey');

  const mods = [];
  let key = null;
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (m) {
      if (!mods.includes(m)) mods.push(m);
    } else {
      key = p;
    }
  }
  if (!key) throw new Error(`hotkey "${spec}" has modifiers but no key`);
  return { mods, key };
}

async function sendHotkey(spec) {
  const { mods, key } = parseHotkey(spec);
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  const code = KEY_CODES[key.toLowerCase()];
  const action = code !== undefined
    ? `key code ${code}${using}`
    : `keystroke ${JSON.stringify(key.length === 1 ? key : key.toLowerCase())}${using}`;

  try {
    await pexecFile('osascript', ['-e', `tell application "System Events" to ${action}`]);
  } catch (err) {
    const msg = err.stderr || err.message || '';
    if (/not allowed|1002|assistive/i.test(msg)) {
      throw new Error(
        `Sending keystrokes needs Accessibility permission. Grant it to the app running ` +
          `this command (Terminal / iTerm / your editor) in ` +
          `System Settings › Privacy & Security › Accessibility, then retry.\n${msg}`
      );
    }
    throw new Error(`failed to send hotkey "${spec}": ${msg}`);
  }
  return { mods, key, sent: spec };
}

async function findApp({ bundleId, app }) {
  const apps = await listApps();
  if (bundleId) {
    const want = bundleId.toLowerCase();
    return apps.find((a) => a.bundleId.toLowerCase() === want) || null;
  }
  if (app) {
    const want = normalize(app);
    return (
      apps.find((a) => normalize(a.name) === want) ||
      apps.find((a) => normalize(a.name).includes(want)) ||
      null
    );
  }
  return null;
}

async function windowsFor(sel) {
  const { bundleId, app, title, all, onscreen } = sel;
  // Asking about one specific app means hidden windows count too — that is the
  // whole point of being able to capture a settings window nobody can see.
  const includeOffscreen = !onscreen && Boolean(all || bundleId || app);
  const raw = await listWindowsRaw({ includeOffscreen });
  return filterWindows(raw, { bundleId, app, title, all, onscreen });
}

/**
 * Make sure the app has the kind of window the caller needs, doing the least
 * disruptive thing that gets there: already-there → launch → activate → hotkey.
 *
 * `wantVisible` is the important knob. By default a hidden window counts as
 * success, because screencapture can capture one perfectly well and summoning
 * it would needlessly steal focus. Set wantVisible when the window has to be
 * really on screen — then, and only then, is a hotkey worth sending.
 *
 * Checking before every escalation is what keeps the hotkey safe: these are
 * usually toggles, so firing one at an app whose window is already up would
 * close the very thing the caller asked for.
 */
async function ensureWindows(sel, opts = {}) {
  const { hotkey = null, timeout = 6000, launch = true, wantVisible = false } = opts;
  const steps = [];

  // Deliberately drops --title. "Does this app already have a window open?" has
  // to be answered for ANY window: if a title the caller asked for happens not
  // to exist yet, that is not a reason to fire a toggle hotkey at an app whose
  // other window is sitting right there — doing so closes it. Callers narrow by
  // title afterwards, on whatever this returns.
  const existSel = { ...sel, title: undefined };

  const check = async () => {
    const found = await windowsFor(existSel);
    return wantVisible ? found.filter((w) => w.onScreen) : found;
  };

  const waitFor = async (ms) => {
    const deadline = Date.now() + ms;
    let found = await check();
    while (!found.length && Date.now() < deadline) {
      await sleep(250);
      found = await check();
    }
    return found.length ? settle(found) : found;
  };

  // A window that was just summoned is usually mid fade-in. Capturing right
  // then yields a washed-out, semi-transparent frame, so wait for the alpha to
  // finish animating before handing the window back.
  const settle = async (found) => {
    for (let i = 0; i < SETTLE_TRIES && found.some((w) => w.alpha < SETTLE_ALPHA); i++) {
      await sleep(SETTLE_POLL_MS);
      const next = await check();
      if (!next.length) return found;
      found = next;
    }
    return found;
  };

  let windows = await check();
  if (windows.length) {
    steps.push('already-open');
    return { windows, steps, launched: false };
  }

  let running = await findApp(sel);
  let launched = false;

  if (!running) {
    if (!launch) {
      throw new Error(
        `app not running${sel.bundleId ? ` (${sel.bundleId})` : ''} and --no-launch was set`
      );
    }
    if (!sel.bundleId) {
      throw new Error(
        `"${sel.app}" is not running and cannot be launched by name. ` +
          `Pass --bundle <bundle id> so appshot knows what to open.`
      );
    }
    steps.push('launch');
    try {
      await pexecFile('open', ['-b', sel.bundleId]);
    } catch (err) {
      throw new Error(
        `could not launch bundle id "${sel.bundleId}": ${err.stderr || err.message}`
      );
    }
    launched = true;

    const deadline = Date.now() + timeout;
    while (!running && Date.now() < deadline) {
      await sleep(250);
      running = await findApp(sel);
    }
    if (!running) throw new Error(`launched "${sel.bundleId}" but it never showed up as running`);

    windows = await waitFor(timeout);
    if (windows.length) return { windows, steps, launched };
  }

  // Bring it forward. Menu bar apps often only build a window once activated.
  steps.push('activate');
  try {
    await pexecFile('osascript', [
      '-e',
      `tell application id ${JSON.stringify(running.bundleId)} to activate`,
    ]);
  } catch {
    try {
      await pexecFile('open', ['-b', running.bundleId]);
    } catch {
      /* best effort — the hotkey below may still work */
    }
  }
  windows = await waitFor(Math.min(timeout, 2500));
  if (windows.length) return { windows, steps, launched };

  // Last resort: some windows only exist while a global hotkey holds them open.
  if (hotkey) {
    steps.push(`hotkey:${hotkey}`);
    await sendHotkey(hotkey);
    windows = await waitFor(timeout);
    if (windows.length) return { windows, steps, launched, hotkeySent: hotkey };
  }

  return { windows: [], steps, launched };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

// Flags that are switches, never value-takers. Without this list `--activate -o
// out.png` would quietly swallow the -o as --activate's value and the file would
// land somewhere else entirely.
const BOOLEAN_FLAGS = new Set([
  'all', 'onscreen', 'activate', 'focus', 'full', 'shadow', 'help', 'version', 'no-launch',
]);

// Flags that must be followed by a value. Listing them explicitly is what lets
// `--rect -100,0,800,600` work: a value starting with a single dash is a real
// case (a display to the left of the primary one has negative coordinates), and
// guessing from the leading dash used to swallow it and capture the whole screen
// while still reporting success.
// Keep in sync with the code below — scripts/selftest.mjs cross-checks these two
// sets against every flag the source actually reads and fails if one is missing.
const VALUE_FLAGS = new Set([
  'window', 'bundle', 'app', 'title', 'out', 'pick', 'max', 'width', 'dir',
  'filter', 'display', 'rect', 'timeout', 'hotkey', 'keys',
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
        throw new Error(`unknown flag "--${name}"`);
      }
      const next = argv[i + 1];
      // Only a double dash ends a value. Single-dash tokens are taken as the
      // value, so negative numbers and coordinates survive.
      if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true; // validated below: a value flag left true is an error
      }
      continue;
    }

    if (a === '-o') {
      const next = argv[i + 1];
      // Same rule the long flags use. Without it `-o --activate` writes to a
      // file literally named "--activate" and drops the flag, silently.
      if (next === undefined || next.startsWith('--')) {
        throw new Error('-o needs a path');
      }
      flags.out = next;
      i++;
      continue;
    }

    // Anything else starting with a dash is a typo, not a filename. Catching it
    // here stops "-onscreen" from being read as "-o" plus the path "nscreen".
    if (a.startsWith('-') && a !== '-') {
      throw new Error(`unknown flag "${a}" (did you mean "-${a}"?)`);
    }

    positional.push(a);
  }

  for (const [name, value] of Object.entries(flags)) {
    if (VALUE_FLAGS.has(name) && value === true) {
      throw new Error(`--${name} needs a value`);
    }
  }

  return { flags, positional };
}

function selectorFrom(flags) {
  return {
    bundleId: typeof flags.bundle === 'string' ? flags.bundle : undefined,
    app: typeof flags.app === 'string' ? flags.app : undefined,
    title: typeof flags.title === 'string' ? flags.title : undefined,
    all: flags.all === true || flags.all === 'true',
    onscreen: flags.onscreen === true || flags.onscreen === 'true',
  };
}

function requireSelector(sel) {
  if (!sel.bundleId && !sel.app) {
    throw new Error('need --bundle <bundle id> or --app <name>');
  }
}

function num(v, dflt) {
  if (v === undefined || v === true) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function maxFrom(flags) {
  if (flags.full) return 0;
  return num(flags.max, 1600);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

const HELP = `appshot — screenshot a specific macOS app window

  list      [--bundle ID] [--app NAME] [--title TEXT] [--onscreen] [--all]
            List matching windows as JSON. With --bundle/--app this includes
            hidden and off-screen windows, because those can still be captured.
            --onscreen keeps only visible ones; --all also keeps system chrome.

  apps      [--filter TEXT]
            List running apps with their bundle ids. Use this to resolve a name.

  shot      (--window ID | --bundle ID | --app NAME) [--title TEXT]
            [--pick first|largest|frontmost] [-o PATH] [--max N | --full]
            [--activate] [--hotkey "cmd shift v"] [--focus] [--shadow]
            Capture one window. With several matches and no --pick, exits 2 and
            prints the candidates so the caller can choose. A hidden window
            captures fine as-is; add --focus to force it to the front first.

  preview   (--bundle ID | --app NAME) [--dir DIR] [--width N]
            Capture every matching window as a small thumbnail, one file each.
            Look at them to decide which window you actually want.

  activate  (--bundle ID | --app NAME) [--hotkey "cmd shift v"] [--timeout MS]
            Launch / focus the app and wait until it has a window. Prints what it did.
            Works on the app, not one window, so --title has no effect here.

  hotkey    "cmd shift v"
            Send a global hotkey. Needs Accessibility permission.

  screen    [-o PATH] [--display N] [--rect x,y,w,h] [--max N | --full]
            Whole screen or a rectangle, when no single window is the right answer.

Common flags: --max N shrinks the longest side to N px (default 1600, --full keeps
native size). Every command prints JSON on stdout.`;

async function cmdList(flags) {
  out(await windowsFor(selectorFrom(flags)));
}

async function cmdApps(flags) {
  let apps = await listApps();
  if (typeof flags.filter === 'string') {
    const q = normalize(flags.filter);
    apps = apps.filter((a) => normalize(a.name).includes(q) || normalize(a.bundleId).includes(q));
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  out(apps);
}

function pickWindow(windows, pick) {
  if (!pick || pick === true) return null;
  switch (String(pick)) {
    // The list arrives sorted best-guess-first: ordinary windows before floating
    // panels, visible before hidden, larger before smaller.
    case 'first':
      return windows[0];
    // Deliberately ignores that ranking — "largest" has to mean largest, or the
    // flag lies whenever a small ordinary window outranks a big panel.
    case 'largest':
      return windows.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    case 'frontmost': {
      const onScreen = windows.filter((w) => w.onScreen);
      return onScreen[0] || windows[0];
    }
    default:
      throw new Error(`unknown --pick value "${pick}" (use first, largest or frontmost)`);
  }
}

async function cmdShot(flags) {
  const max = maxFrom(flags);
  const shadow = flags.shadow === true;

  if (flags.window) {
    const id = num(flags.window, NaN);
    if (!Number.isFinite(id)) throw new Error('--window needs a numeric window id');
    const outPath = resolve(flags.out || defaultOutPath(`window-${id}`));
    const res = await captureWindow(id, outPath, { max, shadow });
    out({ ok: true, ...res, windowId: id });
    return;
  }

  const sel = selectorFrom(flags);
  requireSelector(sel);

  let windows;
  let steps;
  // Kept so a --title that matches nothing can report what the app DOES have,
  // instead of a bare "no window matched" the caller cannot act on.
  let beforeTitle = null;
  if (flags.activate || flags.hotkey || flags.focus) {
    const r = await ensureWindows(sel, {
      hotkey: typeof flags.hotkey === 'string' ? flags.hotkey : null,
      timeout: num(flags.timeout, 6000),
      launch: flags['no-launch'] !== true,
      wantVisible: flags.focus === true || flags.onscreen === true,
    });
    windows = r.windows;
    steps = r.steps;
    if (!windows.length) {
      out({
        ok: false,
        error: 'no-windows',
        steps: r.steps,
        message:
          'App is running but produced no capturable window. Try a different --hotkey, ' +
          'or open the window manually and retry.',
      });
      process.exitCode = 3;
      return;
    }
    // ensureWindows answers "any window at all", on purpose — narrowing by
    // title is this step's job, once the app is known to have windows.
    if (sel.title) {
      beforeTitle = windows;
      windows = matchByTitle(windows, sel.title);
    }
  } else {
    windows = await windowsFor(sel);
    if (!windows.length && sel.title) {
      beforeTitle = await windowsFor({ ...sel, title: undefined });
    }
  }

  if (!windows.length) {
    // The app has windows, just none with that title — say so and hand over the
    // list, since the caller can pick from it immediately.
    if (beforeTitle && beforeTitle.length) {
      out({
        ok: false,
        error: 'title-no-match',
        selector: sel,
        available: beforeTitle,
        message:
          `No window titled like "${sel.title}", but the app has ${beforeTitle.length} other ` +
          `window(s) — listed in "available". Capture one with --window <id>, or drop --title ` +
          'and use `appshot preview` to look at them if the titles are empty.',
      });
      process.exitCode = 2;
      return;
    }
    out({
      ok: false,
      error: 'no-match',
      selector: sel,
      message:
        'No window matched. Run `appshot list --bundle <id>` to see what exists, or add ' +
        '--activate --hotkey "..." if the window has to be summoned first.',
    });
    process.exitCode = 2;
    return;
  }

  let target = windows[0];
  if (windows.length > 1) {
    const picked = pickWindow(windows, flags.pick);
    if (!picked) {
      out({
        ok: false,
        error: 'ambiguous',
        count: windows.length,
        candidates: windows,
        message:
          'Several windows matched. Re-run with --title to narrow it down, --pick ' +
          'first|largest|frontmost to choose mechanically, or use `appshot preview` ' +
          'to look at them and pick by eye.',
      });
      process.exitCode = 2;
      return;
    }
    target = picked;
  }

  const tag = `${target.app}-${target.id}`;
  const outPath = resolve(flags.out || defaultOutPath(tag));
  const res = await captureWindow(target.id, outPath, { max, shadow });
  out({ ok: true, ...res, window: target, ...(steps ? { steps } : {}) });
}

async function cmdPreview(flags) {
  const sel = selectorFrom(flags);
  requireSelector(sel);

  let windows;
  if (flags.activate || flags.hotkey) {
    const r = await ensureWindows(sel, {
      hotkey: typeof flags.hotkey === 'string' ? flags.hotkey : null,
      timeout: num(flags.timeout, 6000),
      launch: flags['no-launch'] !== true,
      wantVisible: flags.focus === true || flags.onscreen === true,
    });
    windows = r.windows;
    if (sel.title) windows = matchByTitle(windows, sel.title);
  } else {
    windows = await windowsFor(sel);
  }

  if (!windows.length) {
    out({ ok: false, error: 'no-match', selector: sel });
    process.exitCode = 2;
    return;
  }

  const dir = resolve(
    flags.dir || join(tmpdir(), 'appshot', `preview-${sel.bundleId || sel.app}`.replace(/[^\w.-]+/g, '_'))
  );
  mkdirSync(dir, { recursive: true });
  const width = num(flags.width, 520);

  const shots = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const p = join(dir, `${String(i + 1).padStart(2, '0')}-win${w.id}.png`);
    try {
      const res = await captureWindow(w.id, p, { max: width });
      shots.push({ index: i + 1, ...res, window: w });
    } catch (err) {
      shots.push({ index: i + 1, window: w, error: String(err.message || err) });
    }
  }
  out({ ok: true, dir, count: shots.length, shots });
}

async function cmdActivate(flags) {
  const sel = selectorFrom(flags);
  requireSelector(sel);
  const r = await ensureWindows(sel, {
    hotkey: typeof flags.hotkey === 'string' ? flags.hotkey : null,
    timeout: num(flags.timeout, 6000),
    launch: flags['no-launch'] !== true,
    wantVisible: flags.focus === true || flags.onscreen === true,
  });
  out({
    ok: r.windows.length > 0,
    steps: r.steps,
    launched: r.launched,
    count: r.windows.length,
    windows: r.windows,
  });
  if (!r.windows.length) process.exitCode = 3;
}

async function cmdHotkey(flags, positional) {
  const spec = positional[0] || (typeof flags.keys === 'string' ? flags.keys : null);
  if (!spec) throw new Error('usage: appshot hotkey "cmd shift v"');
  out({ ok: true, ...(await sendHotkey(spec)) });
}

async function cmdScreen(flags) {
  const outPath = resolve(flags.out || defaultOutPath('screen'));
  const res = await captureScreen(outPath, {
    max: maxFrom(flags),
    display: typeof flags.display === 'string' ? flags.display : null,
    rect: typeof flags.rect === 'string' ? flags.rect : null,
  });
  out({ ok: true, ...res });
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const cmd = positional.shift() || (flags.help ? 'help' : 'help');

  if (cmd === 'version' || flags.version) {
    out({ name: 'appshot', version: readVersion() });
    return;
  }
  if (cmd === 'help' || flags.help) {
    process.stdout.write(`appshot ${readVersion()}\n\n${HELP}\n`);
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('appshot only works on macOS (it uses screencapture and CoreGraphics)');
  }

  switch (cmd) {
    case 'list': return cmdList(flags);
    case 'apps': return cmdApps(flags);
    case 'shot': return cmdShot(flags);
    case 'preview': return cmdPreview(flags);
    case 'activate': return cmdActivate(flags);
    case 'hotkey': return cmdHotkey(flags, positional);
    case 'screen': return cmdScreen(flags);
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

// Compare real paths, not path strings. On macOS /tmp is a symlink to
// /private/tmp, and a home directory can be symlinked too; a string comparison
// then decides the script was merely imported and silently does nothing at all
// while still exiting 0 — the worst possible failure for a CLI.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(self) === realpathSync(process.argv[1]);
  } catch {
    return resolve(self) === resolve(process.argv[1]);
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    out({ ok: false, error: 'failed', message: String(err.message || err) });
    process.exit(1);
  });
}

export {
  listWindowsRaw, listApps, filterWindows, matchByTitle, captureWindow,
  captureScreen, ensureWindows, sendHotkey, parseHotkey, findApp,
};
