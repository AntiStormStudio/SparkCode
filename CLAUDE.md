# CLAUDE.md

This file provides guidance to Claude (Claude Code / Claude Desktop) when working with code in this repository.

## Project Overview

**SPARK-Code** is a reconstructed TypeScript CLI application — the source of `spark-code` (originally Claude Code), restored from npm package source maps. It is a ~2000-file, ~500K-line codebase that provides an terminal-based AI coding assistant with a React + Ink TUI (Terminal User Interface).

- **Language**: TypeScript (ESM, React + Ink for TUI)
- **Runtime**: Bun ≥ 1.3.5 (primary), Node.js ≥ 24 (compatible)
- **Package Manager**: bun
- **License**: SEE LICENSE IN LICENSE.md (Anthropic copyright, reconstructed for research)

## Quick Start

```bash
bun install       # Install dependencies and local shim packages
bun run dev       # Start the interactive CLI (src/dev-entry.ts → src/main.tsx)
bun run version   # Verify version output
```

## Architecture

### Entry Points

```
bin/sparkc (shell bootstrap) → src/dev-entry.ts → src/main.tsx (TUI main loop)
                                              → src/commands.ts (CLI command registration)
```

### Core Layers

| Layer | Key Files | Responsibility |
|-------|-----------|----------------|
| **TUI Main Loop** | `src/main.tsx` | React + Ink terminal UI, CLI argument parsing, session lifecycle |
| **Command Registry** | `src/commands.ts` | Slash command registration, skill/plugin loading |
| **Tools** | `src/tools/` | ~53 tool implementations (Bash, FileEdit, Agent, MCP, etc.) |
| **Services** | `src/services/` | API clients, MCP management, analytics, autoDream memory |
| **Components** | `src/components/` | ~148 React terminal UI components |
| **Hooks** | `src/hooks/` | ~87 custom React hooks |
| **State** | `src/state/`, `src/context.ts` | AppState store, React context injection |
| **Schemas** | `src/schemas/` | Zod validation schemas |
| **Query Engine** | `src/query.ts`, `src/QueryEngine.ts` | Semantic search (Fuse.js fuzzy matching) |

### Key Subsystems

- **`src/buddy/`** — AI virtual pet system (feature-gated: `BUDDY`)
- **`src/assistant/` + `src/proactive/`** — KAIROS persistent assistant mode with background tasks and auto-dreaming
- **`src/coordinator/`** — Multi-agent orchestration (Coordinator dispatches to Worker subprocesses)
- **`src/bridge/`** (33 files) — WebSocket remote control bridge
- **`src/vim/`** — Vim keyboard shortcut engine
- **`src/voice/`** — Voice interaction support
- **`src/screens/`** — Full-screen interfaces (login, setup wizard)
- **`src/server/`** — Built-in HTTP/WebSocket server
- **`src/remote/`** — Remote session management, teleport

## Feature Gating (Three-Layer)

The codebase uses a three-tier feature gate system:

1. **Compile-time**: `feature('FLAG')` — ~50 build switches (BUDDY, KAIROS, ULTRAPLAN, COORDINATOR_MODE, BRIDGE_MODE, etc.)
2. **User type**: `USER_TYPE === 'ant'` (internal) vs `'external'` (public) — 600+ conditional checks
3. **Remote A/B**: GrowthBook SDK (`@growthbook/growthbook`) — 20min (internal) / 6hr (external) refresh

## Coding Conventions

- **TypeScript ESM**, no semicolons, single quotes
- **camelCase** for variables/functions, **PascalCase** for React components/classes
- **kebab-case** for command folder names (e.g., `src/commands/install-slack-app/`)
- Keep imports stable when comments warn against reordering
- Prefer small, focused modules over broad utility dumps

## Testing

No consolidated test suite. Validate manually:

```bash
bun run dev       # Smoke-test CLI boot
bun run version   # Verify version output
```

When adding changes, exercise the specific command/service/UI path affected.

## Important Notes

- This is a **reconstructed source tree** from source maps, not pristine upstream
- Prefer minimal, auditable changes
- Document any workaround added due to restored/shim behavior
- Native modules are shimmed in `shims/` and `vendor/`
