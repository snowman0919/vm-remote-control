import { EventEmitter } from 'events';
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
