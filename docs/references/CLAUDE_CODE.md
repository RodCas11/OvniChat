# Claude Code project harness

> Documentation snapshot: **2026-08-17**. Claude Code evolves quickly; recheck the linked official
> documentation before changing harness semantics or relying on a newly introduced field.

This repository keeps its durable engineering rules in normal project documentation and uses
Claude Code's project-scoped configuration only to make those rules discoverable and actionable.
The harness is an aid to engineering judgment, not a security boundary.

## Project layout and choices

| Path                          | Purpose                                                       | Project choice                                                                                       |
| ----------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                   | Instructions loaded for project sessions and custom subagents | Concise map, boundaries, workflow, and validation commands; detailed material stays under `docs/`    |
| `.claude/settings.json`       | Shared Claude Code settings                                   | Conservative default permission mode and denials for likely secret files; no blanket shell approvals |
| `.claude/settings.local.json` | Per-machine settings and remembered approvals                 | Local only and ignored by version control; never use it as shared policy                             |
| `.claude/agents/*.md`         | Focused custom subagents                                      | Narrow role, explicit tools, inherited model, and a required deliverable format                      |
| `.claude/skills/*/SKILL.md`   | Reusable project workflows                                    | Short procedural guidance that points back to canonical project documentation                        |

The root `CLAUDE.md` deliberately uses ordinary Markdown links rather than `@path` imports. An
`@path` directive eagerly imports the referenced file into context and can recurse through imports;
it is not merely a link. Loading all project documentation on every turn would waste context and
make the important rules harder to find.

Claude Code does not automatically load `AGENTS.md`. That file exists for other engineering agents;
the Claude-specific source of instructions is `CLAUDE.md`. Keep the two aligned when a project-wide
rule changes, but do not import one wholesale into the other.

## Agents

Project agents live in `.claude/agents/` and cover architecture, Electron desktop work, real-time
backend work, WebRTC/media, Windows media capture, infrastructure, security review, and quality
assurance. Each agent file has YAML frontmatter followed by its role instructions.

- `name` and `description` are required. Names use lowercase letters and hyphens.
- `tools` is an explicit least-privilege allowlist. Review roles should remain read-only; an
  implementation role receives editing or shell tools only when its job requires them.
- The model is not version-pinned. Omitting `model` lets the agent inherit the session model and
  avoids stale configuration.
- Do not use `permissionMode: bypassPermissions`.
- An agent already receives the project `CLAUDE.md` hierarchy, its task, a git snapshot when
  available, and any explicitly preloaded skills. Do not duplicate the whole project handbook in
  every prompt.
- Preloading a skill through an agent's `skills` field places the whole skill in initial context.
  Use this only when the agent needs it on essentially every invocation.
- The agent body must ask for an inspectable deliverable: files inspected, findings, risks,
  recommendations or changes, and checks actually run.

Descriptions affect automatic delegation. Say that an agent should be used proactively only when
that is intended. Worktree isolation is also opt-in: current Claude Code can base an isolated
worktree on its configured fresh/default-branch reference rather than the caller's uncommitted
working tree, so it must not be enabled casually in this scaffold.

## Skills

Every project skill lives at `.claude/skills/<skill-name>/SKILL.md`. The directory contains the
workflow; canonical product, architecture, security, and completion requirements remain under
`docs/`.

- Provide a precise `description`, because Claude uses it for discovery and automatic invocation.
- Keep the body focused and link only the project documents needed for that workflow.
- Omit `allowed-tools` unless the skill intentionally needs temporary pre-approval for those tools.
- Use `disable-model-invocation: true` only for a genuinely manual operation. It prevents automatic
  invocation and also prevents that skill from being preloaded into subagents.
- Use `shell: powershell` for a Windows-specific skill when shell semantics matter. Do not assume
  every Claude Code session exposes only Bash.
- Keep credentials, machine paths, and personal preferences out of project skills.

## Settings and permissions

The checked-in `.claude/settings.json` uses the official schema URL and a normal approval mode. It
denies Claude's file tools access to `.env`, private-key, PEM, and ignored Coturn runtime
configuration files. These rules reduce accidental access but do not replace filesystem
permissions, sandboxing, secret scanning, or review: a shell command is a separate capability, and
`CLAUDE.md` instructions are advisory.

Permission rules from all settings scopes combine, with `deny` taking precedence over `ask`, then
`allow`. A broad deny cannot be undone by a narrower project allow. Managed policy has the highest
precedence; command-line, local, project, and user settings follow in that order.

Do not check in blanket approvals for package installation, `pnpm` scripts, arbitrary PowerShell,
Git publishing, deployment, or destructive container operations. Script bodies can change over
time. Developers may approve a known command for their own machine in
`.claude/settings.local.json`, subject to organizational policy. Where supported, set
`disableBypassPermissionsMode` to `"disable"` through managed or project policy so bypass mode
cannot be selected.

## Verification

After dependencies are installed, run the repository checks from the workspace root:

```powershell
pnpm verify:harness
pnpm verify:secrets
pnpm verify
pnpm check
```

`pnpm verify:harness` checks expected agents, skills, frontmatter, and required documentation.
`pnpm verify:secrets` checks the repository for likely committed secrets. `pnpm verify` combines the
repository-specific guardrails, while `pnpm check` is the complete formatting, lint, type, test,
build, and verification gate. Report only commands actually run and their real results.

In an interactive Claude Code session, use these built-in diagnostics after changing the harness:

```text
/status
/context
/permissions
/doctor
```

Confirm which instruction files and settings scopes loaded, inspect effective permissions, and
restart the session if a newly created agent directory is not discovered. Existing agent and skill
files normally reload without a restart.

## Primary sources

- [Claude Code documentation index](https://code.claude.com/docs/llms.txt)
- [Manage Claude's memory and `CLAUDE.md`](https://code.claude.com/docs/en/memory)
- [The `.claude` directory](https://code.claude.com/docs/en/claude-directory)
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code security](https://code.claude.com/docs/en/security)
- [Claude Code settings JSON schema](https://json.schemastore.org/claude-code-settings.json)

The schema can lag a newly released CLI field. When they disagree, verify behavior against the
current Claude Code version and the live official documentation rather than guessing.
