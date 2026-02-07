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
    vision: {
      model: process.env.VMRC_VISION_MODEL || 'qwen3-vl:8b',
      base_url: process.env.VMRC_VISION_BASE_URL,
    },
  });

  await provider.init();
  const session = await provider.startSession({ backend, label: domain, readOnly: false });

  const plan = await session.visionPlan(prompt);
  console.log('Vision plan:', JSON.stringify(plan, null, 2));

  if (!process.env.VMRC_DRY_RUN) {
    for (const action of plan.actions) {
      await session.sendInput(action);
    }
  }

  await session.close();
}

main().catch((error) => {
  console.error('Vision plan failed', error);
  process.exit(1);
});
