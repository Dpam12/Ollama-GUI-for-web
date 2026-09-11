# Ollama Studio

A zero-dependency web GUI for [Ollama](https://ollama.com). Single command to start, no build step, no `npm install`.

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

Environment variable `OLLAMA_HOST` overrides `ollamaBase`.

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

All `/api/*` endpoints require the access token if one is set (via `Authorization: Bearer <token>` header or `?token=` query parameter).

## Requirements

- **Node.js 18+** (uses built-in `fetch`, `crypto`, `zlib`, `dgram`)
- **Ollama** running locally or on the network

## License

MIT

*This code and description was written with AI*
