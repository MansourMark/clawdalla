# Clawdalla

A personal AI assistant that lives on your own main computer.

- **Clawdalla** – a simple chat. It answers in jokes when you're just talking and turns plain and precise the moment it does real work.
- **Clawdalla Coder** – a coding agent that builds and changes projects on the main computer.
- **One main computer, every device.** The main computer runs the assistant and stores all chats and projects. Your phone, tablet and laptop use it through the web or the desktop app.
- **Your own API key.** Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, xAI, Mistral, a local Ollama, or any OpenAI-compatible endpoint.

## Install

Download the installer for your computer from the [Releases](../../releases) page.

| Computer | File |
|---|---|
| Windows | `Clawdalla-<version>-win-x64.exe` |
| Mac (Apple Silicon) | `Clawdalla-<version>-mac-arm64.dmg` |
| Mac (Intel) | `Clawdalla-<version>-mac-x64.dmg` |

The installers are not code-signed.

- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway**.
- **Mac:** drag Clawdalla to Applications, then right-click it and choose **Open**. If macOS says the app is damaged, run `xattr -cr /Applications/Clawdalla.app` in Terminal once.

## Set up (about five minutes)

### 1. The main computer

Use a computer that stays on and plugged in.

1. Open Clawdalla and choose **This is my main computer**.
2. Choose a password. Your other devices sign in with it.
3. Paste an API key. That's all it needs to work.

Closing the window keeps Clawdalla running in the tray, and it starts again when you log in.

### 2. Your other devices

Clawdalla uses [Tailscale](https://tailscale.com/download), a free private network between your own devices, so nothing is exposed to the public internet.

1. Install Tailscale on the main computer and on each other device, signed in to the same account.
2. On the main computer open **Settings → Other devices → Turn on secure access**. It shows an address like `https://my-pc.tail1234.ts.net`. (The first time, Tailscale may ask you to enable HTTPS certificates in its admin console.)
3. On each other device, either:
   - open that address in a browser and sign in – on a phone, use **Add to Home Screen** to get an app icon and notifications; or
   - install the desktop app, choose **Connect to my main computer**, and enter the address.

## What it can do

**Levels.** Every message runs at Fast, Medium or Smart. **Auto** judges each message and picks one. Settings → Levels shows which model each level uses and lets you change it.

**Tools on the main computer.** Read, write and edit files, search code, run shell commands, fetch web pages, search the web (works without a key; add a Tavily or Brave key for steadier results), and drive its own browser window (Edge on Windows, Chrome on Mac).

**Permissions.** Choose how much it asks first: everything, risky actions only (default), or never. Approval cards appear on whichever device you're using. A project can be set to never ask.

**Coder.**

- **Plan / Build.** Plan investigates and proposes without touching files; Build does the work.
- **Automatic check.** After the coder changes files, Clawdalla runs the project's check command (tests, build or type-check – detected automatically, or set per project) and sends failures back to be fixed, up to three rounds by default.
- **Undo.** Rolls back the last request together with its file changes. Redo brings it back.
- **Changes panel.** See the diff, discard a file, commit, or ask for a fresh-eyes review.
- **Run and preview.** Run a command, or start the project's app on the main computer and open it from any device.
- **New app from an idea.** Describe an app – from your phone if you like. It is created and built on the main computer, so you can put the phone away; a notification arrives when it's done or needs you.

**Plugins.** Add MCP servers in Settings → Plugins (a command to run on the main computer, or a URL).

**Voice.** In a browser, the microphone button dictates and the speaker button reads a reply aloud. Dictation isn't available inside the desktop app; use the browser for that.

## Things to know

- Everything is stored in one folder on the main computer: `%APPDATA%\Clawdalla\data` on Windows, `~/Library/Application Support/Clawdalla/data` on Mac. New apps go in its `workspaces` folder. Back up that folder to back up Clawdalla.
- API keys are kept in that folder in `settings.json`, readable by your user account on the main computer. They are never sent to your other devices.
- Clawdalla can run commands on the main computer. It listens only on the computer itself and on your Tailscale network, behind your password. Don't forward its ports to the internet.
- The app preview (port 4781) has no password of its own; it is reachable only from the main computer and your Tailscale devices.
- Undo and the Changes panel need Git installed on the main computer.
- It is a chat and an agent, not a code editor: there is no inline autocomplete as you type.
- The joke setting applies to new conversations.

## Development

```bash
npm install
npm run server
```

`npm run server` builds everything and runs the host without the desktop window (data goes in `./.data`); it prints a local link to open. `npm start` runs the desktop app, `npm run dist` builds an installer for the current platform, and `npm run typecheck` checks types.

```
server/agent/   the agent engine: providers, tools, the model/tool loop, plugins, undo snapshots
server/         host server: login, API, live events, projects, checks, previews
web/            the interface (React)
electron/       desktop shell: main-computer mode and connect mode
```

Pushing a tag like `v1.0.1` builds the Windows and Mac installers with GitHub Actions and attaches them to a release.
