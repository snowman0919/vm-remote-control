# VM Remote-Control Plugin for OpenClaw

This plugin provides a **remote-control provider** for virtual machines, enabling OpenClaw agents to view and control VM desktops (VNC/RDP/SPICE/etc.).

## What’s Included (MVP)
- **Provider API** with session lifecycle and events
- **Mock backend** (default) that streams placeholder frames and accepts input
- **Pluggable backend driver** interface (VNC implemented, RDP/WebRTC placeholders)
- **Session utilities**: snapshots, clipboard, viewport, health checks
- **OCR + UI state helpers** (tesseract-backed text extraction + search)

> SPICE is now backed by `virsh` (screenshots + basic input). VNC/RDP/WebRTC remain mocked.

---

## Installation
```bash
pnpm add openclaw-plugin-vm-remote-control
```

## Configuration
```json
{
  "plugins": {
    "vm-remote-control": {
      "default_backend": "mock",
      "frame_interval_ms": 1000,
      "mock": {
        "label": "Demo VM",
        "width": 1280,
        "height": 720
      },
      "vnc": {
        "host": "127.0.0.1",
        "port": 5901,
        "password": "***"
      }
    }
  }
}
```

### VNC (vncsnapshot + vncdo)

```json
{
  "plugins": {
    "vm-remote-control": {
      "default_backend": "vnc",
      "vnc": {
        "host": "127.0.0.1",
        "port": 5901
      }
    }
  }
}
```

**Dependencies**
- `vncsnapshot`
- `vncdo` (from `vncdotool`)

---

### SPICE (virsh-backed)

```json
{
  "plugins": {
    "vm-remote-control": {
      "default_backend": "spice",
      "spice": {
        "domain": "Win11",
        "use_guest_screenshot": true,
        "guest_screenshot_path": "C:\\vmrc\\shot.png"
      }
    }
  }
}
```

**Notes/limits**
- Keyboard input: QMP key down/up with retry; falls back to `virsh send-key` for down events.
- Mouse input: QMP absolute moves + scroll; mouse clicks move-to-x/y first when provided and retry on failure.
- Clipboard: tries QEMU guest agent first (`guest-set-clipboard`), falls back to keystroke injection.
- Screenshots: can use guest agent capture to avoid black screens (see below).

## Vision Planning (Qwen3-VL via Ollama)

This plugin can call a local **Ollama** model (default: `qwen3-vl:8b`) to convert a screenshot into a structured input plan.

### Prerequisites
```bash
ollama pull qwen3-vl:8b
```

### Configuration
```json
{
  "plugins": {
    "vm-remote-control": {
      "vision": {
        "model": "qwen3-vl:8b",
        "base_url": "http://127.0.0.1:11434",
        "timeout_ms": 30000
      }
    }
  }
}
```

### Usage
```ts
const plan = await session.visionPlan('Click the Start menu');
console.log(plan.summary, plan.actions);
for (const action of plan.actions) {
  await session.sendInput(action);
}
```

The vision planner expects **JSON-only** output in the format:
```json
{
  "summary": "...",
  "actions": [
    { "type": "mouse-move", "x": 120, "y": 340 },
    { "type": "mouse-button", "button": "left", "action": "down" },
    { "type": "mouse-button", "button": "left", "action": "up" }
  ]
}
```

## OCR / UI State Helpers
The OCR helpers shell out to the `tesseract` CLI. Install it first:
```bash
sudo apt-get install -y tesseract-ocr
```

You can read text from the current frame and search for matches using simple text queries or regex.

## Usage
```ts
import VMRemoteControlProvider from 'openclaw-plugin-vm-remote-control';

const provider = new VMRemoteControlProvider(context); // context provided by OpenClaw
await provider.init();

const session = await provider.startSession({
  backend: 'mock',
  label: 'Example VM',
  viewport: { width: 1024, height: 768 },
  readOnly: false
});

session.on('frame', (frame) => {
  // frame.buffer contains PNG bytes
  console.log('Frame received', frame.width, frame.height);
});

await session.sendInput({ type: 'key', key: 'Enter', action: 'down' });
await session.sendInput({ type: 'key', key: 'Enter', action: 'up' });
await session.setClipboard('Hello VM');

const snapshot = await session.snapshot();
console.log('Snapshot mime', snapshot.mimeType);

// OCR (requires `tesseract` CLI)
const ocr = await session.ocrSnapshot({ language: 'eng', psm: 6 });
console.log('OCR text', ocr.text);

const matches = await session.findText(/welcome/i, { scope: 'line' });
console.log('Found', matches.length, 'matches');

await session.close();
```

## API Summary
### Provider
- `init(): Promise<void>`
- `startSession(params: StartSessionParams): Promise<RemoteControlSession>`
- `endSession(sessionId: string): Promise<void>`
- `getSession(sessionId: string): RemoteControlSession | undefined`
- `listSessions(): RemoteControlSession[]`

### Session Events
- `frame` → emitted with `Frame` whenever a frame is captured
- `status` → `connecting | connected | disconnected | error`

### OCR Helpers
- `ocrSnapshot(options?: OCRSnapshotOptions): Promise<OCRResult>`
- `findText(query: string | RegExp, options?: FindTextOptions): Promise<OCRMatch[]>`

### Input Events
```ts
{ type: 'key', key: 'A', action: 'down' }
{ type: 'text', text: 'hello' }
{ type: 'mouse-move', x: 100, y: 200 }
{ type: 'mouse-button', button: 'left', action: 'down', x: 100, y: 200 }
{ type: 'mouse-scroll', deltaY: -120 }
{ type: 'clipboard', text: 'copy me' }
```

## Backend Roadmap
- **VNC**: basic connect + capture + input ✅
- **RDP**: Windows-friendly sessions
- **SPICE**: virsh-backed (basic) ✅
- **WebRTC**: low-latency streaming

## Development Notes
- The mock backend uses a 1x1 PNG buffer and emits frames at `frame_interval_ms`.
- Replace `MockBackendDriver` with real protocol drivers when integrating.
- Basic SPICE end-to-end test:
  ```bash
  pnpm build
  VMRC_SPICE_DOMAIN=Win11 pnpm spice:e2e
  ```

- Vision plan demo (Ollama required):
  ```bash
  VMRC_SPICE_DOMAIN=Win11 pnpm vision:plan -- "Click the Start menu"
  ```

---

## License
MIT
