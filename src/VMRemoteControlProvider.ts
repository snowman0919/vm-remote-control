import type { VMRemoteControlOptions } from './types.js';

/**
 * VMRemoteControlProvider (skeleton)
 *
 * TODO: Implement OpenClaw remote-control provider interface once finalized.
 */
export class VMRemoteControlProvider {
  readonly id = 'vm-remote-control';

  constructor(private readonly options: VMRemoteControlOptions = {}) {}

  /**
   * Initialize any global resources (e.g., connection pools).
   */
  async init(): Promise<void> {
    // TODO: wire up backend drivers
  }

  /**
   * Start a remote-control session.
   */
  async startSession(): Promise<void> {
    // TODO: create backend session (VNC/RDP/SPICE/etc.)
  }

  /**
   * Stop/cleanup a session.
   */
  async stopSession(): Promise<void> {
    // TODO: teardown backend session
  }
}
