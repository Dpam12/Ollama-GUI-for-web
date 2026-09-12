# Ollama Studio

A zero-dependency web GUI for [Ollama](https://ollama.com). Single command to start, no build step, no `npm install`.

**Version 2** adds brain-routed image generation and an agentic coding mode (see [Features](#features)).

## Quick Start

```bash
# 1. Make sure Ollama is running
ollama serve

# 2. Start the GUI
node server.js

# 3. Open http://localhost:8899
```

### LAN Access

```bash
node server.js --host 0.0.0.0
# Open http://YOUR_LAN_IP:8899 from any device
```

### Custom Port

```bash
node server.js --port 3000
```

## Features

- **Zero dependencies** — pure Node.js 18+, nothing to install
- **Streaming chat** — real-time SSE responses with markdown rendering and syntax highlighting
- **Brain-routed image generation** — the model itself decides whether a request wants an image ("draw me a cat") and routes it to an image model automatically. No manual toggle.
- **Agentic coding mode** — a Chat/Agent toggle. Agent mode runs shell commands and reads/writes files inside a workspace folder, driven by the active model emitting tool calls (`run`, `read`, `write`, `list`) with live progress cards.
- **Auto-installed dependencies** — on each agent run the server checks project manifests (`package.json`, `requirements.txt`/`pyproject.toml`, `go.mod`, `Gemfile`) and installs what's missing (falls back to a local `.venv` for Python on externally-managed systems).
- **Default agent workspace** — created automatically at `~/Ollama_Code_Output`; empty workspace in Settings resets to it.
- **Recommended models** — defaults listed in Settings appear with one-click **Pull** buttons when not installed yet.
- **Code blocks** — language detection, one-click copy, dark-themed with highlighting
- **Model management** — list, pull, delete, and inspect model details
- **Per-chat settings** — temperature, top-p, top-k, context length, seed
- **System prompts** — set per conversation
- **Memory system** — auto-learns facts about you from conversations, or add manual notes
- **Auto-titles** — conversations named automatically from the first message
- **Conversation history** — search, edit, delete, regenerate, insert messages
- **Export / import** — full JSON backup of all conversations and memory
- **Access token** — optional password protection for LAN access
- **Dark + light themes** — toggle in settings
- **Mobile responsive** — works on phones and tablets with touch-friendly controls
- **Keyboard shortcuts** — Ctrl+N (new chat), Ctrl+K (search), Esc (stop/close)

## Configuration

Settings are saved in `data/config.json`. You can also change them from the Settings panel in the UI.

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `8899` | Server port |
| `host` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `ollamaBase` | `http://127.0.0.1:11434` | Ollama server URL |
| `accessToken` | `""` | Optional access token for LAN |
| `customUrl` | `""` | Public/custom URL shown in settings |
| `autoTitle` | `true` | Auto-name conversations |
| `autoMemory` | `true` | Auto-learn facts from chats |
| `defaultModels` | `[]` | Comma-separated recommended chat models — auto-selected if installed, listed with a Pull button if not |
| `imageModel` | `""` | Model used for image generation. Leave empty to auto-detect any installed image model |
| `workspace` | `~/Ollama_Code_Output` | Agent workspace folder; created automatically if missing, empty resets to the default |

Environment variable `OLLAMA_HOST` overrides `ollamaBase`.

> `data/` is runtime-only and not committed — it is created on first start.

## Project Structure

```
ollama-gui/
  server.js          # Entire backend — HTTP server, API proxy, SSE streaming
  public/
    index.html       # SPA shell
    app.js           # Frontend logic — chat, models, memory, settings
    style.css        # All styles — dark/light themes, responsive
  data/              # Created at runtime
    config.json      # Persistent settings
    conversations.json
    memory.json
  start.sh           # Convenience launcher
  start.bat          # Windows launcher
  package.json
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server + Ollama status |
| GET | `/api/models` | List installed models |
| POST | `/api/model` | Get model details |
| DELETE | `/api/model/:name` | Delete a model |
| POST | `/api/pull` | Pull a model (SSE stream) |
| POST | `/api/chat` | Chat completion (SSE stream) |
| POST | `/api/generate` | Single-turn generation |
| POST | `/api/title` | Generate conversation title |
| GET/POST | `/api/conversations` | List or create conversations |
| GET/PATCH/DELETE | `/api/conversations/:id` | Read, update, or delete a conversation |
| GET/POST | `/api/memory` | List or add memory entries |
| PATCH/DELETE | `/api/memory/:id` | Update or delete a memory entry |
| POST | `/api/memory/extract` | Auto-learn facts from a conversation |
| POST | `/api/export` | Export all data |
| POST | `/api/import` | Import from backup |
| POST | `/api/reset` | Delete all data |
| GET/POST | `/api/config` | Read or update settings |
| POST | `/api/route` | Classify whether a request wants an image (`{"action":"image"}` or `"chat"`) — the "brain" |
| POST | `/api/image` | Generate an image with the configured image model (SSE/base64 response) |
| POST | `/api/agent` | Run the agent tool loop (SSE events: `delta`, `tool`, `tool-result`, `deps`, `done`, `error`). Tool-call protocol: `<toolcall><task>TOOL</task><arg>ARG</arg></toolcall>` |

All `/api/*` endpoints require the access token if one is set (via `Authorization: Bearer <token>` header or `?token=` query parameter).

## Requirements

- **Node.js 18+** (uses built-in `fetch`, `crypto`, `zlib`, `dgram`)
- **Ollama** running locally or on the network

## License

MIT

*This code and description was written with AI*
