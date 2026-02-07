# VM Remote-Control Plugin for OpenClaw

This plugin provides a **remote-control provider** for virtual machines, enabling OpenClaw agents to view and control VM desktops (VNC/RDP/SPICE/etc.).

## What’s Included (MVP)
- **Provider API** with session lifecycle and events
- **Mock backend** (default) that streams placeholder frames and accepts input
- **Pluggable backend driver** interface (VNC/RDP/WebRTC placeholders)
- **Session utilities**: snapshots, clipboard, viewport, health checks

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

### SPICE (virsh-backed)

```json
{
  "plugins": {
    "vm-remote-control": {
      "default_backend": "spice",
      "spice": {
        "domain": "Win11"
      }
    }
  }
}
```

**Notes/limits**
- Keyboard input: basic keys/text via `virsh send-key` (best-effort).
- Mouse input: QMP absolute moves + scroll (best-effort).
- Clipboard: tries QEMU guest agent first (`guest-set-clipboard`), falls back to keystroke injection.

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
- **VNC**: connect/auth + frame capture + input injection
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

---

## License
MIT
