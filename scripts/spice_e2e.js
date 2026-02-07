#!/usr/bin/env node
/* eslint-disable no-console */

const { VMRemoteControlProvider } = require('../dist/VMRemoteControlProvider.js');

async function main() {
  const domain = process.env.VMRC_SPICE_DOMAIN || process.env.SPICE_DOMAIN || process.env.DOMAIN;
  if (!domain) {
    console.error('Missing domain. Set VMRC_SPICE_DOMAIN (or SPICE_DOMAIN/DOMAIN).');
    process.exit(1);
  }

  const provider = new VMRemoteControlProvider({
    default_backend: 'spice',
    spice: { domain },
    frame_interval_ms: 1000,
  });

  await provider.init();
  const session = await provider.startSession({ backend: 'spice', label: domain, readOnly: false });

  session.on('frame', (frame) => {
    console.log(`Frame: ${frame.width}x${frame.height} @ ${new Date(frame.timestamp).toISOString()}`);
  });

  await session.sendInput({ type: 'mouse-move', x: 50, y: 50 });
  await session.sendInput({ type: 'mouse-button', button: 'left', action: 'down' });
  await session.sendInput({ type: 'mouse-button', button: 'left', action: 'up' });
  await session.sendInput({ type: 'mouse-scroll', deltaY: -120 });
  await session.setClipboard('vm-remote-control e2e');

  const snapshot = await session.snapshot();
  console.log(`Snapshot mime: ${snapshot.mimeType}, bytes=${snapshot.buffer.length}`);

  await session.close();
}

main().catch((error) => {
  console.error('E2E test failed', error);
  process.exit(1);
});
