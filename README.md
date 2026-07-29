# appshot

**Let your coding agent screenshot one specific macOS app window.**

`screencapture` — the command line tool every agent reaches for — can grab the
whole screen or a rectangle, and that is it. It cannot tell you what windows
exist, so it cannot capture *that app's settings page*. appshot closes the gap.

```
you:    screenshot PastePaw's settings page
agent:  → resolves the app, lists its windows, finds the one titled "General",
          captures just that window, and looks at the result
```

No screen flicker, nothing brought to the front, no other windows in the shot.

---

## Install

```bash
npx github:XueshiQiao/appshot
```

That drops the skill into `~/.claude/skills/appshot`. Start a new session and ask
for a screenshot in plain language.

| Where | Command |
|---|---|
| Claude Code, user-wide | `npx github:XueshiQiao/appshot` |
| Claude Code, this project only | `npx github:XueshiQiao/appshot --project` |
| Codex | `npx github:XueshiQiao/appshot --codex` |
| Somewhere else | `npx github:XueshiQiao/appshot --dir <path>` |

Try it without installing anything:

```bash
npx github:XueshiQiao/appshot list --app Finder
```

Requires macOS and Node 18+. No dependencies — it uses `screencapture`, `sips`
and JavaScript for Automation, all of which ship with macOS.

To check an install is healthy:

```bash
node ~/.claude/skills/appshot/scripts/selftest.mjs
```

### Versions

```bash
node ~/.claude/skills/appshot/scripts/appshot.mjs version   # what you have
npx github:XueshiQiao/appshot                               # update to latest
npx github:XueshiQiao/appshot#v1.0.5                        # pin a release
```

Updating replaces the installed directory, so keep local edits somewhere else.
If the destination exists but is not an appshot install, it is left alone unless
you pass `--force`.

---

## What it handles

**Hidden windows.** macOS keeps a window's rendered contents even when it is off
screen or buried. appshot captures that directly, so an app's settings window can
be photographed without ever appearing on the user's screen — and the shot is
live, not a stale frame.

**Apps that are not running.** `--activate` launches the app, waits for a window,
and captures it.

**Menu bar apps with no window at all.** Some apps only build their window when
you press a global hotkey. `--hotkey "cmd shift v"` sends it first. appshot
re-checks before every escalation, so it never fires a toggle hotkey at an app
whose window is already open.

**Several windows, no useful titles.** `preview` captures each candidate as a
thumbnail so the agent can look at them and pick the right one by eye — which is
how a request like "the login sheet" gets answered when no title says "login".

**Multiple monitors.** Irrelevant, and that is the point: a per-window capture
comes from the window, not from a screen, so a window on your second display —
or parked at negative coordinates off every display — captures just the same.

---

## Commands

```
apps      [--filter TEXT]                     running apps + bundle ids
list      [--bundle ID|--app NAME] [--title TEXT] [--onscreen] [--all]
shot      (--window ID|--bundle ID|--app NAME) [--title TEXT] [-o PATH]
          [--pick first|largest|frontmost] [--max N|--full]
          [--activate] [--hotkey "cmd shift v"] [--focus] [--shadow]
preview   --bundle ID [--dir DIR] [--width N]
activate  --bundle ID [--hotkey "cmd shift v"] [--timeout MS]
hotkey    "cmd shift v"
screen    [-o PATH] [--display N] [--rect x,y,w,h]
```

Everything prints JSON. Examples:

```bash
APPSHOT="node ~/.claude/skills/appshot/scripts/appshot.mjs"

$APPSHOT apps --filter finder
$APPSHOT list --bundle com.apple.finder
$APPSHOT shot --bundle com.apple.finder --title Downloads -o /tmp/dl.png
$APPSHOT shot --bundle com.apple.calculator --activate -o /tmp/calc.png
$APPSHOT preview --bundle me.xueshi.pastepaw --dir /tmp/pp
```

`--max N` shrinks the longest side to N px (default 1600) to keep images cheap
for an agent to read; `--full` keeps native retina size.

---

## Permissions

| Need | When | Where |
|---|---|---|
| Screen & System Audio Recording | always | System Settings › Privacy & Security › Screen & System Audio Recording |
| Accessibility | only for `--hotkey` | System Settings › Privacy & Security › Accessibility |

Grant these to the program running the command — Terminal, iTerm, your editor —
not to appshot. Without screen recording, window titles come back empty and
captures are blank.

---

## 中文说明

`screencapture` 只能截整屏或一个矩形，它不知道系统里有哪些窗口，所以没法「截某个 APP 的设置页」。
appshot 补上的就是这一步：列出全部窗口（含隐藏的）→ 挑出你要的那个 → 只截它。

```bash
npx github:XueshiQiao/appshot        # 装到 ~/.claude/skills/appshot
```

装完开个新会话，直接说「帮我截一下 PastePaw 的设置页」就行。

几个也许出乎意料的点：

- **窗口藏着也能截。** macOS 会保留窗口画面，哪怕它在屏幕外、被别的窗口盖住。所以截图不会
  让窗口在你屏幕上闪一下，也不会有别的窗口挡在前面，而且截到的是实时画面不是旧的。
- **APP 没启动也行。** `--activate` 会先把它拉起来，等窗口出现再截。
- **纯后台的菜单栏 APP** 窗口要按快捷键才存在，用 `--hotkey "cmd shift v"`。每次升级前都会
  重新检查，所以不会出现「窗口本来开着，结果一发快捷键反而给关了」。
- **多个窗口又都没标题**时，用 `preview` 把每个窗口都拍成缩略图，让 agent 看图挑。
- **几块显示器无所谓。** 截单个窗口读的是窗口自己的画面，不是从某块屏幕上抠像素。

需要在「系统设置 › 隐私与安全性 › 屏幕与系统音频录制」里给你的终端授权；要用快捷键功能的话，
还需要「辅助功能」权限。

---

MIT © [Xueshi Qiao](https://xueshi.dev) · [@XueshiQiao](https://x.com/XueshiQiao)
