import { EventEmitter } from 'events';

export type VMBackend = 'vnc' | 'rdp' | 'spice' | 'webrtc' | 'custom' | 'mock';

export interface VMRemoteControlOptions {
  default_backend?: VMBackend;
  frame_interval_ms?: number;
  connect_timeout_ms?: number;
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
    domain?: string;
  };
  webrtc?: {
    signaling_url?: string;
    token?: string;
  };
  custom?: {
    label?: string;
  };
  mock?: {
    label?: string;
    width?: number;
    height?: number;
    frame_interval_ms?: number;
  };
}

export interface PluginContext {
  logger: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
    debug(message: string, meta?: unknown): void;
  };
  config: {
    get<T = unknown>(key: string): T | undefined;
  };
}

export interface RemoteControlProvider {
  id: string;
  init(): Promise<void>;
  startSession(params: StartSessionParams): Promise<RemoteControlSession>;
  endSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): RemoteControlSession | undefined;
  listSessions(): RemoteControlSession[];
}

export interface StartSessionParams {
  backend?: VMBackend;
  label?: string;
  viewport?: Viewport;
  readOnly?: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Frame {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  timestamp: number;
}

export type KeyAction = 'down' | 'up';

export type InputEvent =
  | { type: 'key'; key: string; action: KeyAction; modifiers?: string[] }
  | { type: 'text'; text: string }
  | { type: 'mouse-move'; x: number; y: number }
  | { type: 'mouse-button'; button: 'left' | 'middle' | 'right'; action: KeyAction; x?: number; y?: number }
  | { type: 'mouse-scroll'; deltaX?: number; deltaY?: number }
  | { type: 'clipboard'; text: string };

export interface RemoteControlSession extends EventEmitter {
  id: string;
  backend: VMBackend;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  label?: string;
  viewport?: Viewport;
  snapshot(): Promise<Frame>;
  sendInput(event: InputEvent): Promise<void>;
  setViewport(viewport: Viewport): Promise<void>;
  setClipboard(text: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}
