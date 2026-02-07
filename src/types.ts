export type VMBackend = 'vnc' | 'rdp' | 'spice' | 'webrtc' | 'custom';

export interface VMRemoteControlOptions {
  default_backend?: VMBackend;
  vnc?: {
    host?: string;
    port?: number;
    password?: string;
  };
  rdp?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
  spice?: {
    host?: string;
    port?: number;
    password?: string;
  };
}
