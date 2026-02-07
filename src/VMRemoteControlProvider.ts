import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import type {
  Frame,
  InputEvent,
  PluginContext,
  RemoteControlProvider,
  RemoteControlSession,
  StartSessionParams,
  VMBackend,
  VMRemoteControlOptions,
  Viewport,
} from './types.js';

const DEFAULT_FRAME_INTERVAL_MS = 1000;
const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };
const DEFAULT_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64'
);

const execFileAsync = promisify(execFile);

interface BackendDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  captureFrame(viewport?: Viewport): Promise<Frame>;
  sendInput(event: InputEvent): Promise<void>;
  setClipboard(text: string): Promise<void>;
  setViewport(viewport: Viewport): Promise<void>;
  healthCheck(): Promise<boolean>;
}

class MockBackendDriver implements BackendDriver {
  constructor(
    private readonly backend: VMBackend,
    private readonly label: string | undefined,
    private readonly viewport: Viewport,
    private readonly frameIntervalMs: number,
    private readonly logger: PluginContext['logger']
  ) {}

  async connect(): Promise<void> {
    this.logger.info(`Mock backend (${this.backend}) connected`, {
      label: this.label,
      viewport: this.viewport,
    });
  }

  async disconnect(): Promise<void> {
    this.logger.info(`Mock backend (${this.backend}) disconnected`, { label: this.label });
  }

  async captureFrame(viewport?: Viewport): Promise<Frame> {
    const targetViewport = viewport ?? this.viewport;
    return {
      buffer: DEFAULT_PNG_BUFFER,
      mimeType: 'image/png',
      width: targetViewport.width,
      height: targetViewport.height,
      timestamp: Date.now(),
    };
  }

  async sendInput(event: InputEvent): Promise<void> {
    this.logger.debug('Mock backend input', { backend: this.backend, event });
  }

  async setClipboard(text: string): Promise<void> {
    this.logger.debug('Mock backend clipboard set', { backend: this.backend, textLength: text.length });
  }

  async setViewport(viewport: Viewport): Promise<void> {
    this.logger.debug('Mock backend viewport update', { backend: this.backend, viewport });
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  get interval(): number {
    return this.frameIntervalMs;
  }
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'KEY_ENTER',
  return: 'KEY_ENTER',
  tab: 'KEY_TAB',
  esc: 'KEY_ESC',
  escape: 'KEY_ESC',
  backspace: 'KEY_BACKSPACE',
  space: 'KEY_SPACE',
  up: 'KEY_UP',
  down: 'KEY_DOWN',
  left: 'KEY_LEFT',
  right: 'KEY_RIGHT',
  shift: 'KEY_LEFTSHIFT',
  ctrl: 'KEY_LEFTCTRL',
  control: 'KEY_LEFTCTRL',
  alt: 'KEY_LEFTALT',
  meta: 'KEY_LEFTMETA',
};

function keyToVirsh(key: string): string | null {
  if (!key) return null;
  const normalized = key.toLowerCase();
  if (KEY_ALIASES[normalized]) return KEY_ALIASES[normalized];
  if (normalized.length === 1) {
    const char = normalized.toUpperCase();
    if (char >= 'A' && char <= 'Z') return `KEY_${char}`;
    if (char >= '0' && char <= '9') return `KEY_${char}`;
    if (char === '.') return 'KEY_DOT';
    if (char === '-') return 'KEY_MINUS';
    if (char === '=') return 'KEY_EQUAL';
    if (char === '/') return 'KEY_SLASH';
    if (char === ',') return 'KEY_COMMA';
  }
  return null;
}

class SpiceVirshDriver implements BackendDriver {
  private mouseX = 0;
  private mouseY = 0;
  private mouseMask = 0;
  private viewport: Viewport;

  constructor(
    private readonly domain: string,
    private readonly logger: PluginContext['logger'],
    viewport: Viewport,
    private readonly absoluteMouse: boolean
  ) {
    this.viewport = viewport;
  }

  private async runVirsh(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('virsh', args);
    return stdout.trim();
  }

  private async runQmp(command: Record<string, unknown>): Promise<void> {
    await execFileAsync('virsh', ['qemu-monitor-command', this.domain, JSON.stringify(command)]);
  }

  async connect(): Promise<void> {
    await this.runVirsh(['domstate', this.domain]);
    const display = await this.runVirsh(['domdisplay', this.domain]);
    this.logger.info('SPICE session connected', { domain: this.domain, display });
  }

  async disconnect(): Promise<void> {
    this.logger.info('SPICE session disconnected', { domain: this.domain });
  }

  async captureFrame(viewport?: Viewport): Promise<Frame> {
    const filePath = `/tmp/vmrc_${this.domain}.png`;
    await this.runVirsh(['screenshot', this.domain, '--file', filePath]);
    const buffer = await readFile(filePath);
    const targetViewport = viewport ?? DEFAULT_VIEWPORT;
    return {
      buffer,
      mimeType: 'image/png',
      width: targetViewport.width,
      height: targetViewport.height,
      timestamp: Date.now(),
    };
  }

  async sendInput(event: InputEvent): Promise<void> {
    switch (event.type) {
      case 'key': {
        if (event.action !== 'down') return;
        const key = keyToVirsh(event.key);
        if (!key) {
          this.logger.warn('Unsupported key', { key: event.key });
          return;
        }
        const modifierKeys = (event.modifiers ?? [])
          .map((modifier) => keyToVirsh(modifier))
          .filter((value): value is string => Boolean(value));
        await this.runVirsh(['send-key', this.domain, ...modifierKeys, key]);
        return;
      }
      case 'text': {
        for (const char of event.text) {
          const key = keyToVirsh(char);
          if (key) {
            await this.runVirsh(['send-key', this.domain, key]);
          }
        }
        return;
      }
      case 'mouse-move': {
        if (this.absoluteMouse) {
          this.mouseX = event.x;
          this.mouseY = event.y;
          const max = 65535;
          const absX = Math.max(0, Math.min(max, Math.round((event.x / this.viewport.width) * max)));
          const absY = Math.max(0, Math.min(max, Math.round((event.y / this.viewport.height) * max)));
          await this.runQmp({
            execute: 'input_send_event',
            arguments: {
              events: [
                { type: 'abs', data: { axis: 'x', value: absX } },
                { type: 'abs', data: { axis: 'y', value: absY } }
              ]
            }
          });
          return;
        }
        const dx = Math.round(event.x - this.mouseX);
        const dy = Math.round(event.y - this.mouseY);
        this.mouseX = event.x;
        this.mouseY = event.y;
        await this.runVirsh(['qemu-monitor-command', '--hmp', this.domain, `mouse_move ${dx} ${dy}`]);
        return;
      }
      case 'mouse-button': {
        if (this.absoluteMouse) {
          await this.runQmp({
            execute: 'input_send_event',
            arguments: {
              events: [
                {
                  type: 'btn',
                  data: {
                    button: event.button === 'left' ? 'left' : event.button === 'right' ? 'right' : 'middle',
                    down: event.action === 'down',
                  }
                }
              ]
            }
          });
          return;
        }
        const bit = event.button === 'left' ? 1 : event.button === 'right' ? 2 : 4;
        if (event.action === 'down') {
          this.mouseMask |= bit;
        } else {
          this.mouseMask &= ~bit;
        }
        await this.runVirsh(['qemu-monitor-command', '--hmp', this.domain, `mouse_button ${this.mouseMask}`]);
        return;
      }
      case 'mouse-scroll': {
        this.logger.warn('Mouse scroll not implemented for SPICE driver');
        return;
      }
      case 'clipboard': {
        await this.setClipboard(event.text);
        return;
      }
      default:
        return;
    }
  }

  async setClipboard(text: string): Promise<void> {
    this.logger.warn('Clipboard set not supported via virsh yet; sending as keystrokes instead', {
      length: text.length,
    });
    for (const char of text) {
      const key = keyToVirsh(char);
      if (key) {
        await this.runVirsh(['send-key', this.domain, key]);
      }
    }
  }

  async setViewport(viewport: Viewport): Promise<void> {
    this.viewport = viewport;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.runVirsh(['domstate', this.domain]);
      return true;
    } catch {
      return false;
    }
  }
}

class UnsupportedBackendDriver implements BackendDriver {
  constructor(private readonly backend: VMBackend) {}

  private unsupported(): never {
    throw new Error(`Backend ${this.backend} not implemented yet`);
  }

  async connect(): Promise<void> {
    this.unsupported();
  }

  async disconnect(): Promise<void> {
    this.unsupported();
  }

  async captureFrame(): Promise<Frame> {
    this.unsupported();
  }

  async sendInput(): Promise<void> {
    this.unsupported();
  }

  async setClipboard(): Promise<void> {
    this.unsupported();
  }

  async setViewport(): Promise<void> {
    this.unsupported();
  }

  async healthCheck(): Promise<boolean> {
    this.unsupported();
  }
}

class VMRemoteControlSessionImpl extends EventEmitter implements RemoteControlSession {
  public status: RemoteControlSession['status'] = 'connecting';
  private frameTimer: NodeJS.Timeout | null = null;
  private frameIntervalMs: number;
  private readonly readOnly: boolean;

  constructor(
    public readonly id: string,
    public readonly backend: VMBackend,
    public label: string | undefined,
    public viewport: Viewport,
    readOnly: boolean,
    private readonly driver: BackendDriver,
    private readonly logger: PluginContext['logger']
  ) {
    super();
    this.readOnly = readOnly;
    this.frameIntervalMs = DEFAULT_FRAME_INTERVAL_MS;
  }

  async start(frameIntervalMs: number): Promise<void> {
    this.frameIntervalMs = frameIntervalMs;
    try {
      await this.driver.connect();
      this.status = 'connected';
      this.emit('status', this.status);
      this.beginFrameLoop();
    } catch (error) {
      this.status = 'error';
      this.emit('status', this.status);
      this.emit('error', error);
      throw error;
    }
  }

  private beginFrameLoop(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
    }
    this.frameTimer = setInterval(async () => {
      try {
        const frame = await this.snapshot();
        this.emit('frame', frame);
      } catch (error) {
        this.logger.warn('Failed to capture frame', { error });
      }
    }, this.frameIntervalMs);
  }

  async snapshot(): Promise<Frame> {
    return this.driver.captureFrame(this.viewport);
  }

  async sendInput(event: InputEvent): Promise<void> {
    if (this.readOnly) {
      this.logger.warn('Ignored input event (read-only session)', { event });
      return;
    }
    return this.driver.sendInput(event);
  }

  async setViewport(viewport: Viewport): Promise<void> {
    this.viewport = viewport;
    await this.driver.setViewport(viewport);
  }

  async setClipboard(text: string): Promise<void> {
    if (this.readOnly) {
      this.logger.warn('Ignored clipboard update (read-only session)');
      return;
    }
    await this.driver.setClipboard(text);
  }

  async healthCheck(): Promise<boolean> {
    return this.driver.healthCheck();
  }

  async close(): Promise<void> {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    await this.driver.disconnect();
    this.status = 'disconnected';
    this.emit('status', this.status);
  }
}

function defaultLogger(): PluginContext['logger'] {
  return {
    info: (message, meta) => console.log(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
    debug: (message, meta) => console.debug(message, meta ?? ''),
  };
}

function createDefaultContext(): PluginContext {
  return {
    logger: defaultLogger(),
    config: {
      get: () => undefined,
    },
  };
}

function isPluginContext(value: unknown): value is PluginContext {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'logger' in value &&
      'config' in value
  );
}

function mergeOptions(...options: Array<VMRemoteControlOptions | undefined>): VMRemoteControlOptions {
  return options.reduce<VMRemoteControlOptions>((acc, current) => {
    if (!current) return acc;
    return {
      ...acc,
      ...current,
      vnc: { ...acc.vnc, ...current.vnc },
      rdp: { ...acc.rdp, ...current.rdp },
      spice: { ...acc.spice, ...current.spice },
      webrtc: { ...acc.webrtc, ...current.webrtc },
      custom: { ...acc.custom, ...current.custom },
      mock: { ...acc.mock, ...current.mock },
    };
  }, {});
}

export class VMRemoteControlProvider implements RemoteControlProvider {
  readonly id = 'vm-remote-control';
  private readonly context: PluginContext;
  private readonly options: VMRemoteControlOptions;
  private readonly sessions = new Map<string, VMRemoteControlSessionImpl>();

  constructor(contextOrOptions?: PluginContext | VMRemoteControlOptions, options?: VMRemoteControlOptions) {
    if (isPluginContext(contextOrOptions)) {
      this.context = contextOrOptions;
      const configOptions =
        this.context.config.get<VMRemoteControlOptions>('vm-remote-control') ??
        this.context.config.get<VMRemoteControlOptions>('vm_remote_control');
      this.options = mergeOptions(configOptions, options);
    } else {
      this.context = createDefaultContext();
      this.options = mergeOptions(contextOrOptions, options);
    }
  }

  async init(): Promise<void> {
    this.context.logger.info('VM Remote Control Provider initialized');
  }

  async startSession(params: StartSessionParams): Promise<RemoteControlSession> {
    const backend = params.backend ?? this.options.default_backend ?? 'mock';
    const viewport = params.viewport ?? DEFAULT_VIEWPORT;
    const label = params.label;
    const readOnly = params.readOnly ?? false;
    const sessionId = `vmrc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (backend !== 'mock') {
      this.context.logger.warn(`Backend ${backend} is running in mock mode until a driver is implemented.`);
    }

    const driver = this.createDriver(backend, label, viewport);
    const session = new VMRemoteControlSessionImpl(
      sessionId,
      backend,
      label,
      viewport,
      readOnly,
      driver,
      this.context.logger
    );

    this.sessions.set(sessionId, session);
    session.on('status', (status) => {
      if (status === 'disconnected' || status === 'error') {
        this.sessions.delete(sessionId);
      }
    });

    const interval = this.resolveFrameInterval(backend);
    await session.start(interval);
    return session;
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.close();
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): RemoteControlSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): RemoteControlSession[] {
    return Array.from(this.sessions.values());
  }

  private resolveFrameInterval(backend: VMBackend): number {
    if (backend === 'mock' && this.options.mock?.frame_interval_ms) {
      return this.options.mock.frame_interval_ms;
    }
    return this.options.frame_interval_ms ?? DEFAULT_FRAME_INTERVAL_MS;
  }

  private createDriver(backend: VMBackend, label: string | undefined, viewport: Viewport): BackendDriver {
    switch (backend) {
      case 'mock':
      case 'custom':
      case 'vnc':
      case 'rdp':
      case 'spice':
      case 'webrtc': {
        if (backend === 'mock') {
          const frameInterval = this.resolveFrameInterval('mock');
          const viewportOverride = {
            width: this.options.mock?.width ?? viewport.width,
            height: this.options.mock?.height ?? viewport.height,
          };
          return new MockBackendDriver(
            backend,
            label ?? this.options.mock?.label,
            viewportOverride,
            frameInterval,
            this.context.logger
          );
        }
        if (backend === 'spice') {
          const domain = label ?? this.options.spice?.domain;
          if (!domain) {
            throw new Error('SPICE backend requires a domain name (label or spice.domain)');
          }
          const absoluteMouse = this.options.spice?.absolute_mouse ?? true;
          return new SpiceVirshDriver(domain, this.context.logger, viewport, absoluteMouse);
        }
        return new MockBackendDriver(
          backend,
          label ?? this.options.custom?.label,
          viewport,
          this.resolveFrameInterval(backend),
          this.context.logger
        );
      }
      default:
        return new UnsupportedBackendDriver(backend);
    }
  }
}
