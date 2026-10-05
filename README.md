# pair

A Claude Code mod that turns Claude into a pair-programming partner: neither of you changes the code without the other.

- **Edit review.** Every `Edit` and `Write` is held until you decide on it, beside its diff.
- **Shared notebook.** A running list of what you have decided and what is still open, which both of you can update.
- **Collaboration instructions.** The bundled `collaborate` skill is sent to Claude once per session, with your first prompt, so Claude explains before it asks, proposes before it builds, and works in small steps.
- **Command review.** When a Bash command changes files, you step through what it changed before Claude goes on.
- **Taking over.** `/pair drive` hands you the keyboard, and `/pair review` has Claude review what you typed.
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
- `/pair help` lists every command, review button and setting, with the settings as they currently are.

With pair mode off, edits run without review, Claude is told to work as it normally would, and the notebook band is hidden. An edit that is being held when you turn it off goes ahead. The setting lasts for the session; a new session starts with pair mode on.

### When a command changes files

A shell command's changes are on disk before anyone can look at them, so they can't be held the way an edit is. Instead, when a Bash command has changed files in a git repository, its result waits while you step through what it changed. The review shows the command, a summary such as `Bash changed 3 files, +42 -7 lines`, and one change at a time, each cut to your review size target.

| Key | Button | What it does |
| --- | --- | --- |
| `1` | Next | This change is fine; show the next one. |
| `2` | Discuss | Mark this change and move on. When you finish, Claude explains the marked ones and waits. |
| `3` | Accept the rest | Stop stepping and let Claude go on. |
| `5` | Whole file | Compare the file as it was before the command with the file now, in VS Code. |
| `Esc` | | Stop here; Claude waits for you in the chat. |

Things to know:

- It works in git repositories only: the repository of the session's folder, or of the folder a command starts by changing into with `cd`.
- The mod takes a snapshot of the repository before and after every Bash command to see what changed. That adds a fraction of a second per command; turn it off with `reviewBash` in `/config`.
- A command left running in the background is not reviewed, and a file you save yourself while a command runs is shown as that command's change.

### Taking over

Sometimes you want to type a change yourself and have Claude review it.

1. `/pair drive [files]`: you take over. The mod notes how your files stand and opens your editor on the files you named, or on the project folder.
2. Type and save in your editor, for as long as you like.
3. `/pair review [note]`: you hand back. Claude is sent what changed since step 1, along with your note, and reviews it: what the change does, bugs, risks, and anything unclear. It is told not to rewrite your work; any fix it proposes is an edit like any other and goes through the review.

For example:

```
/pair review I added a test, but I don't think it covers all the options. Can you suggest more?
```

How the mod knows what you changed:

- **In a git repository** (the one holding the files you named, or the session's folder if you named none) it compares a snapshot of the whole work tree taken at `/pair drive` with one taken at `/pair review`. Untracked files are included, ignored files are not, and changes you already had before driving are left out. Your index, branches and files are not touched; the snapshots are written as unreferenced objects in the repository, which git cleans up on its own.
- **Anywhere else** it watches the files you name plus the files Claude has edited this session, so name the files: `/pair drive src/heap.py`.

Naming files is forgiving. A path can be relative to the session's folder, start with `~`, or be just a file name: `/pair drive heap.py` looks for a file of that name under the session's folder, near the top first, and tells you if there are several. A leading `@` is ignored, so you can complete a path with the file picker.

The editor is VS Code by default. To use another, set `editor` in `/config` to a command that opens files and returns at once, such as `cursor`, `zed` or `idea`.

### Review size target

`maxReviewLines` (default 40) is how many changed lines one edit should stay under. Change it in `/config`. Claude is told the target along with the instructions, a review over it says so, and `Split` sends an oversized edit back. New files show their size without the warning.

### The collaborate skill

The instructions Claude follows live in [`skills/collaborate/SKILL.md`](skills/collaborate/SKILL.md). To use your own version, put it at `~/.claude/skills/collaborate/SKILL.md`; that copy wins over the bundled one.

The instructions go to Claude once per session, with the first prompt you send while pair mode is on. Sending them with every prompt would pile up copies in the conversation. They are sent again with your next prompt after Claude Code compacts the conversation or you run `/clear`, since either one removes them. To put them in front of Claude again yourself, for instance after editing the file or late in a long session, run the skill itself: `/pair:collaborate` for the bundled copy, or `/collaborate` if you keep your own.

### Whole file

`5: Whole file` writes a temporary copy of the file with the edit applied and runs `code --diff <your file> <the copy>`.

- It looks for `code` on your `PATH`, then for the launcher inside `/Applications/Visual Studio Code.app` on macOS.
- The left side is your real file. The right side is the temporary copy; typing into it does not change the edit under review.
- The copy lives in a folder only you can read, under your temp directory, and is deleted as soon as you decide the edit.
- It uses `mkdir` and `rm`, so it works on macOS and Linux, not on Windows.

## What it does not do

- **Only `Edit` and `Write` are held before they happen.** What a `Bash` command changed is reviewed afterwards, in git repositories. `NotebookEdit` and other tools can still change files without review.
- **Headless runs are not held.** With nobody to ask (`claude -p`), edits go straight through.
- **It does not replace Claude Code's permissions.** After you approve an edit, Claude Code's own permission rules still apply to it.

## What the mod does on your machine

- Reads `HOME` and `TMPDIR` to find the skill file and the temp folder.
- Reads the file an edit targets, to draw its diff.
- Runs `git`, `cp` and your editor command when you use `/pair drive` and `/pair review`. The `git` commands read the repository and write snapshot objects through a temporary index; they do not change your index, branches or files.
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
