# VM Remote-Control Plugin for OpenClaw

This plugin will provide a **remote-control provider** for virtual machines, enabling OpenClaw agents to view and control VM desktops (VNC/RDP/SPICE/etc.).

## Scope (Initial)
- **Connect** to a VM console (backend-agnostic; pluggable transport).
- **Stream frames** (or snapshots) to the agent.
- **Inject input**: keyboard, mouse, clipboard.
- **Session lifecycle**: start, stop, reconnect, and health checks.

## Planned Backends
- **VNC** (most universal)
- **RDP** (Windows-friendly)
- **SPICE** (QEMU/KVM)
- **WebRTC** (optional, for low-latency streaming)

## Configuration (Draft)
```json
{
  "plugins": {
    "vm-remote-control": {
      "default_backend": "vnc",
      "vnc": {
        "host": "127.0.0.1",
        "port": 5901,
        "password": "***"
      }
    }
  }
}
```

## Usage (Draft)
```ts
// TODO: provider API once OpenClaw remote-control interface is finalized.
```

## Development Plan
1. **Define Provider Interface**
   - Align with OpenClaw remote-control spec (if any)
   - Decide on frame/stream format + input events
2. **VNC MVP**
   - Connect + authenticate
   - Snapshot/stream + basic input injection
3. **RDP / SPICE adapters**
4. **Session reliability**
   - Reconnect + keepalive
   - Error handling + timeouts
5. **Packaging + docs**

## Notes
- This is an initial scaffold. Implementation will follow once the OpenClaw remote-control API is confirmed.
