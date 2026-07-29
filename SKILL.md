---
name: appshot
description: Screenshot a specific macOS app window — by bundle id, by window title, or by describing the window you want in plain language ("PastePaw's settings page"). Handles apps that are not running yet, windows that are hidden or off screen, and menu bar apps whose window only appears when you press a global hotkey. Use when asked to screenshot / capture / look at / check an app or one of its windows, to see what a UI change looks like, or to verify an app's appearance after editing it.
allowed-tools: Bash, Read
---

# appshot — screenshot one specific macOS app window

`screencapture` alone can only grab the whole screen or a rectangle, because it
has no way to tell you what windows exist. This skill closes that gap: it
enumerates every window on the system (including hidden ones), lets you pick the
one you mean, and captures just that window.

The CLI lives next to this file at `scripts/appshot.mjs`. Run it with `node`:

```bash
node ~/.claude/skills/appshot/scripts/appshot.mjs <command> [flags]
```

Every command prints JSON on stdout. Set `APPSHOT=...` once and reuse it:

```bash
APPSHOT="node ~/.claude/skills/appshot/scripts/appshot.mjs"
```

## Two facts that drive everything else

**1. A hidden window still captures perfectly.** macOS keeps a window's rendered
contents even when the window is off screen, minimized, or behind ten others.
`screencapture -l <windowid>` reads that, so you can photograph an app's settings
page without it ever flashing on the user's screen, and nothing overlaps the
result. Do not activate an app just to capture it.

**2. You cannot capture a window that does not exist.** Menu bar and background
apps often build their window only when summoned. That — not visibility — is the
case where you have to launch the app, focus it, or press its hotkey first.

So: only escalate when `list` comes back empty.

## The decision flow

```
User asks for a screenshot of an app
        │
        ├─ Don't know its bundle id?  ──►  appshot apps --filter <name>
        │
        ▼
appshot list --bundle <id>          (hidden windows included)
        │
        ├── 0 windows ──► appshot activate --bundle <id> [--hotkey "cmd shift v"]
        │                 then list again
        │
        ├── 1 window  ──► appshot shot --bundle <id>
        │
        └── N windows ──► does a title match what the user asked for?
                          ├─ yes ──► appshot shot --bundle <id> --title "<text>"
                          └─ no  ──► appshot preview --bundle <id>
                                     Read the thumbnails, decide by eye,
                                     then appshot shot --window <id>
        │
        ▼
Read the PNG so you can actually see it
```

**Always Read the resulting PNG.** Producing a file is not the same as looking at
it; you cannot describe or verify a UI you have not seen.

## Commands

| Command | What it does |
|---|---|
| `apps [--filter TEXT]` | Running apps with bundle ids. Resolves a name to an id. |
| `list [--bundle ID\|--app NAME] [--title TEXT] [--onscreen] [--all]` | Matching windows as JSON. |
| `shot (--window ID\|--bundle ID\|--app NAME) [--title TEXT] [-o PATH]` | Capture one window. |
| `preview --bundle ID [--dir DIR]` | Thumbnail every matching window, one file each. |
| `activate --bundle ID [--hotkey "cmd shift v"]` | Launch / focus / summon until a window exists. |
| `hotkey "cmd shift v"` | Send a global hotkey by itself. |
| `screen [--display N] [--rect x,y,w,h]` | Whole screen or a rectangle. |
| `version` | Which appshot this is. Quote it when reporting a problem. |

Useful flags: `--max N` shrinks the longest side to N px (default 1600) so the
image is cheap to read — `--full` keeps native retina size when you need to
inspect fine detail. `--pick first|largest|frontmost` resolves ambiguity
mechanically. `--focus` insists the window be really on screen. `--shadow` keeps
the window's drop shadow (off by default).

A window record looks like this. `onScreen: false` is normal and fine:

```json
{ "id": 689, "title": "General", "app": "PastePaw",
  "bundleId": "me.xueshi.pastepaw", "pid": 91387,
  "x": -1650, "y": 386, "width": 740, "height": 640,
  "layer": 0, "onScreen": false, "alpha": 1 }
```

`layer` 0 is an ordinary window; higher layers are floating panels and popovers —
which is exactly what menu bar apps use, so do not discard them.

## Recipes

**Screenshot an app by name**

```bash
$APPSHOT apps --filter pastepaw          # → me.xueshi.pastepaw
$APPSHOT shot --bundle me.xueshi.pastepaw -o /tmp/pp.png
```

**"Screenshot the settings page"** — settings windows are usually titled after
the selected pane (`General`, `Advanced`, `设置`), so try the title first:

```bash
$APPSHOT list --bundle me.xueshi.pastepaw
# one window is titled "General" → that is the settings window
$APPSHOT shot --bundle me.xueshi.pastepaw --title General -o /tmp/settings.png
```

**Windows have no titles, so you have to look** — this is how plain-language
requests get answered when titles tell you nothing:

```bash
$APPSHOT preview --bundle me.xueshi.pastepaw --dir /tmp/pp-preview
```

Read each thumbnail, decide which one the user meant, then capture it full size
with `shot --window <id>`. Thumbnails default to 520 px, so looking at five of
them is cheap.

**The app is not running**

```bash
$APPSHOT shot --bundle com.apple.calculator --activate -o /tmp/calc.png
```

`--activate` launches it, waits for a window, and captures. The result's `steps`
field tells you what it actually had to do (`launch`, `activate`, `hotkey:…`).

**A menu bar app whose window only exists while a hotkey holds it open**

```bash
$APPSHOT shot --bundle me.xueshi.pastepaw --focus --hotkey "cmd shift v" -o /tmp/pp.png
```

`--focus` means "must be really on screen", which is what makes the hotkey step
fire. appshot re-checks before each escalation, so it never sends the hotkey to
an app whose window is already up — these hotkeys are toggles and that would
close the window instead of opening it.

Hotkeys are written as `"cmd shift v"` or `"cmd+shift+v"`. Modifiers: `cmd`,
`shift`, `ctrl`, `opt`, `fn`. Named keys (`return`, `escape`, `space`, `tab`,
arrows, `f1`–`f12`) work alongside single characters.

**If you summoned a window, put it back.** Send the same hotkey again once you
are done, so the user's screen ends up how they left it.

## Permissions

| Need | When | Where to grant |
|---|---|---|
| Screen & System Audio Recording | always | System Settings › Privacy & Security › Screen & System Audio Recording |
| Accessibility | only for `--hotkey` / `hotkey` | System Settings › Privacy & Security › Accessibility |

Grant them to the program running the command — Terminal, iTerm, your editor —
not to appshot itself. Without screen recording, window titles come back empty
and captures are blank. Tell the user which toggle to flip; you cannot grant
these yourself.

## Gotchas

- **`window` in the output is the window as it was *before* the capture.** If
  `suspectBlank` is true, the PNG is suspiciously small and probably empty —
  re-run with `--focus`.
- **Window ids are not stable.** They change when a window is closed and
  reopened. List, then capture, in the same breath; do not cache an id.
- **Values starting with a single dash are fine** (`--rect -2560,0,400,300` for a
  display left of the primary one). Only a value starting with `--` needs the
  `--title=--weird` form. An unknown or mistyped flag is an error, never a
  silently ignored one.
- **A freshly summoned window is mid fade-in.** appshot waits for the window's
  alpha to settle before capturing, so the shot is not washed out — but if a
  capture ever looks translucent, wait a moment and take it again.
- **Multiple displays do not matter for `shot`.** A window on a second monitor,
  or parked at negative coordinates off every screen, captures exactly like one
  in front of the user — there is no display to choose, because the capture
  comes from the window rather than from a screen. Only `screen` takes
  `--display N`.
- **Do not paste captured screenshots of the user's private apps anywhere
  public.** Clipboard managers, mail, and messaging apps show real personal data.
