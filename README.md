# pair

A Claude Code mod that turns Claude into a pair-programming partner: neither of you changes the code without the other.

- **Edit review.** Every `Edit` and `Write` is held until you decide on it, beside its diff.
- **Shared notebook.** A running list of what you have decided and what is still open, which both of you can update.
- **Collaboration instructions.** The bundled `collaborate` skill is attached to every prompt you send, so Claude explains before it asks, proposes before it builds, and works in small steps.
- **One switch.** `/pair` turns all of it on or off.

## Requirements

- Claude Code with function-hook mods available. This mod was written and tested against Claude Code 2.1.289.
- The mod API is early access and can change between Claude Code releases. If a release breaks the mod, or mods are switched off in your build, it will not load.
- Optional: Visual Studio Code, for the whole-file comparison. See [Whole file](#whole-file).

## Install

```sh
claude plugin marketplace add cxxr/pair
claude plugin install pair@cxxr
```

To try it from a clone without installing:

```sh
git clone https://github.com/cxxr/pair
claude --plugin-dir ./pair
```

## Using it

Pair mode is on when a session starts.

### The review

When Claude calls `Edit` or `Write`, the call is held and a pane opens showing:

- the file path,
- Claude's one-sentence reason for the change,
- the size of the change, such as `+12 -3 lines.`, with a warning when it is over your size target,
- the diff.

If the pane does not fit your terminal, the same review is drawn above the prompt.

| Key | Button | What it does |
| --- | --- | --- |
| `1` | Approve | The edit runs as written. Claude is told you approved it. |
| `2` | Discuss | The edit is refused. Claude explains its reasoning and waits for your reply. |
| `3` | Skip | The edit is refused and Claude drops it. |
| `4` | Wide view / Narrow view | Shows 20 lines around each change instead of 3 and asks for a wider pane. Press again to go back. |
| `5` | Whole file | Opens a side-by-side comparison of the whole file in VS Code. The path at the top of the review does the same. |
| `6` | Split | The edit is refused. Claude breaks it into smaller steps and sends the first. |
| `Esc` | | The edit is refused and Claude waits for you in the chat. |

The number keys work while the review has the keyboard. If it does not, click a button, or press `ctrl+x tab` first.

To get its reason in front of you, Claude calls a small tool, `explain_edit`, before each edit. An edit that arrives without a reason is refused with a message telling Claude to explain and try again.

### The notebook

- A band above the prompt shows the notebook: one line when the terminal is narrow, the latest entries when it is wide.
- `/notebook` opens the full list in a pane.
- `/notebook decided <text>` and `/notebook open <text>` add an entry.
- `/notebook resolve <id> [answer]` moves an open question to Decided.
- `/notebook edit <id> <text>`, `/notebook remove <id>` and `/notebook clear` change or delete entries.

Claude adds and resolves entries through its own `notebook` tool.

### The switch

- `/pair` flips pair mode.
- `/pair on` and `/pair off` set it.
- `/pair status` says which it is and which skill file is in use.

With pair mode off, edits run without review, your prompts go as typed, and the notebook band is hidden. An edit that is being held when you turn it off goes ahead. The setting lasts for the session; a new session starts with pair mode on.

### Review size target

`maxReviewLines` (default 40) is how many changed lines one edit should stay under. Change it in `/config`. Claude is told the target with every prompt, a review over it says so, and `Split` sends an oversized edit back. New files show their size without the warning.

### The collaborate skill

The instructions Claude follows live in [`skills/collaborate/SKILL.md`](skills/collaborate/SKILL.md). To use your own version, put it at `~/.claude/skills/collaborate/SKILL.md`; that copy wins over the bundled one. The file is read each time you send a prompt, so edits take effect immediately.

### Whole file

`5: Whole file` writes a temporary copy of the file with the edit applied and runs `code --diff <your file> <the copy>`.

- It looks for `code` on your `PATH`, then for the launcher inside `/Applications/Visual Studio Code.app` on macOS.
- The left side is your real file. The right side is the temporary copy; typing into it does not change the edit under review.
- The copy lives in a folder only you can read, under your temp directory, and is deleted as soon as you decide the edit.
- It uses `mkdir` and `rm`, so it works on macOS and Linux, not on Windows.

## What it does not do

- **Only `Edit` and `Write` are held.** `Bash`, `NotebookEdit` and other tools can still change files without review.
- **Headless runs are not held.** With nobody to ask (`claude -p`), edits go straight through.
- **It does not replace Claude Code's permissions.** After you approve an edit, Claude Code's own permission rules still apply to it.

## What the mod does on your machine

- Reads `HOME` and `TMPDIR` to find the skill file and the temp folder.
- Reads the file an edit targets, to draw its diff.
- Runs `mkdir` and `code` when you press Whole file, and `rm -rf` on its own temp folder when you decide an edit you opened that way or when the mod starts and finds leftovers.
- Lets Claude call the mod's own two tools, `explain_edit` and `notebook`, without a permission prompt. They only change the mod's own session state.

## How the hold works

A function hook that simply waits is cut off by Claude Code after ten seconds, and the tool call then runs. Time spent inside a call to the engine is not counted, so the review waits inside a nested engine call instead, a tick at a time. If the hold itself ever fails, the edit is refused, not run. A test holds an edit for longer than ten seconds to guard this.

## Developing

```sh
claude plugin validate .
claude plugin test .
```

Loading the mod from this folder makes Claude Code write its API types to `.claude-plugin/types/` and a `tsconfig.json` beside them; both are ignored by git. If `tsc -p .` runs out of memory with many MCP tools connected, type-check against `.claude-plugin/types/claude-code` and `.claude-plugin/types/claude-code-tools` only.

The test kit cannot simulate a person closing a pane, so the `Esc` path has no automated test.

## License

MIT. See [LICENSE](LICENSE).
