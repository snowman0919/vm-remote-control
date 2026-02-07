#!/usr/bin/env node
/* eslint-disable no-console */

const { VMRemoteControlProvider } = require('../dist/VMRemoteControlProvider.js');

async function main() {
  const prompt = process.argv.slice(2).join(' ') || 'Click the Start menu';
  const backend = process.env.VMRC_BACKEND || 'spice';
  const domain = process.env.VMRC_SPICE_DOMAIN || process.env.SPICE_DOMAIN || process.env.DOMAIN;

  if (backend === 'spice' && !domain) {
    console.error('Missing domain. Set VMRC_SPICE_DOMAIN (or SPICE_DOMAIN/DOMAIN).');
    process.exit(1);
  }

  const provider = new VMRemoteControlProvider({
    default_backend: backend,
    spice: domain ? { domain } : undefined,
    vnc: {
      host: process.env.VMRC_VNC_HOST || '127.0.0.1',
      port: process.env.VMRC_VNC_PORT ? Number(process.env.VMRC_VNC_PORT) : 5901,
    },
    vision: {
      model: process.env.VMRC_VISION_MODEL || 'qwen3-vl:8b',
      base_url: process.env.VMRC_VISION_BASE_URL,
      timeout_ms: process.env.VMRC_VISION_TIMEOUT_MS
        ? Number(process.env.VMRC_VISION_TIMEOUT_MS)
        : undefined,
      max_image_width: process.env.VMRC_VISION_MAX_WIDTH
        ? Number(process.env.VMRC_VISION_MAX_WIDTH)
        : undefined,
    },
  });

  await provider.init();
  const session = await provider.startSession({ backend, label: domain, readOnly: false });

  const plan = await session.visionPlan(prompt);
  console.log('Vision plan:', JSON.stringify(plan, null, 2));

  const mappedActions = (plan.actions ?? []).flatMap((action) => {
    if (!action || typeof action !== 'object') return [];
    if (action.type === 'click') {
      const x = typeof action.x === 'number' ? action.x : action.position?.x;
      const y = typeof action.y === 'number' ? action.y : action.position?.y;
      if (typeof x === 'number' && typeof y === 'number') {
        return [
          { type: 'mouse-move', x, y },
          { type: 'mouse-button', button: 'left', action: 'down', x, y },
          { type: 'mouse-button', button: 'left', action: 'up', x, y },
        ];
      }
    }
    if (action.type === 'type' && typeof action.text === 'string') {
      return [{ type: 'text', text: action.text }];
    }
    if (action.type === 'key') {
      const keys = Array.isArray(action.keys) ? action.keys : action.key ? [action.key] : [];
      return keys.map((key) => ({ type: 'key', key: String(key), action: 'down' }));
    }
    return [];
  });

  if (!process.env.VMRC_DRY_RUN) {
    for (const action of mappedActions) {
      await session.sendInput(action);
    }
  }

  await session.close();
}

main().catch((error) => {
  console.error('Vision plan failed', error);
  process.exit(1);
});
