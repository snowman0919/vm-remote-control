import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
  OCRResult,
  OCRSnapshotOptions,
  OCRWord,
  OCRLine,
  OCRMatch,
  FindTextOptions,
  VisionActionPlan,
  VisionPlanOptions,
} from './types.js';

const DEFAULT_FRAME_INTERVAL_MS = 1000;
const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };
const DEFAULT_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64'
);

const DEFAULT_VISION_MODEL = 'qwen3-vl:8b';
const DEFAULT_VISION_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_VISION_TIMEOUT_MS = 30000;
const DEFAULT_VISION_SYSTEM_PROMPT = `You are a UI automation planner. Given a screenshot and a user goal, respond with JSON only: {"summary": string, "actions": InputEvent[]} where InputEvent matches the VM remote-control schema. Use absolute pixel coordinates from the screenshot for mouse actions. Keep actions minimal and safe.`;

const execFileAsync = promisify(execFile);

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const signature = buffer.slice(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function normalizeText(value: string, matchCase: boolean): string {
  return matchCase ? value : value.toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOllamaBaseUrl(baseUrl?: string): string {
  const env = process.env.OLLAMA_HOST;
  const raw = baseUrl ?? env ?? DEFAULT_VISION_BASE_URL;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return `http://${raw}`;
}

function extractJsonFromText(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return text.slice(first, last + 1).trim();
  }
  return null;
}

function normalizeInputEvent(value: unknown): InputEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Partial<InputEvent> & { type?: string };
  switch (event.type) {
    case 'key':
      if (typeof event.key === 'string' && (event.action === 'down' || event.action === 'up')) {
        return { type: 'key', key: event.key, action: event.action, modifiers: Array.isArray(event.modifiers) ? event.modifiers.map(String) : undefined };
      }
      return null;
    case 'text':
      if (typeof event.text === 'string') {
        return { type: 'text', text: event.text };
      }
      return null;
    case 'mouse-move':
      if (typeof event.x === 'number' && typeof event.y === 'number') {
        return { type: 'mouse-move', x: event.x, y: event.y };
      }
      return null;
    case 'mouse-button':
      if ((event.button === 'left' || event.button === 'middle' || event.button === 'right') && (event.action === 'down' || event.action === 'up')) {
        const normalized: InputEvent = { type: 'mouse-button', button: event.button, action: event.action };
        if (typeof event.x === 'number') normalized.x = event.x;
        if (typeof event.y === 'number') normalized.y = event.y;
        return normalized;
      }
      return null;
    case 'mouse-scroll':
      if (typeof event.deltaX === 'number' || typeof event.deltaY === 'number') {
        return { type: 'mouse-scroll', deltaX: event.deltaX, deltaY: event.deltaY };
      }
      return null;
    case 'clipboard':
      if (typeof event.text === 'string') {
        return { type: 'clipboard', text: event.text };
      }
      return null;
    default:
      return null;
  }
}

function parseVisionPlan(text: string): VisionActionPlan {
  const json = extractJsonFromText(text) ?? text.trim();
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const fallbackActions: InputEvent[] = [];
    const actionRegex = /\{[^}]*?"?type"?\s*:\s*"?(click|type|key)"?[^}]*?\}/gi;
    const matches = text.match(actionRegex) ?? [];
    for (const match of matches) {
      if (/"?type"?\s*:\s*"?click"?/i.test(match)) {
        const x = Number(match.match(/"?x"?\s*:\s*(\d+)/i)?.[1]);
        const y = Number(match.match(/"?y"?\s*:\s*(\d+)/i)?.[1]);
        if (!isNaN(x) && !isNaN(y)) {
          fallbackActions.push({ type: 'mouse-move', x, y });
          fallbackActions.push({ type: 'mouse-button', button: 'left', action: 'down', x, y });
          fallbackActions.push({ type: 'mouse-button', button: 'left', action: 'up', x, y });
        }
      } else if (/"?type"?\s*:\s*"?type"?/i.test(match)) {
        const textMatch = match.match(/"?text"?\s*:\s*"([^"]+)"/i);
        if (textMatch?.[1]) fallbackActions.push({ type: 'text', text: textMatch[1] });
      } else if (/"?type"?\s*:\s*"?key"?/i.test(match)) {
        const keyMatch = match.match(/"?key"?\s*:\s*"([^"]+)"/i);
        if (keyMatch?.[1]) fallbackActions.push({ type: 'key', key: keyMatch[1], action: 'down' });
      }
    }
    if (fallbackActions.length) {
      return { summary: 'Fallback parsed actions from non-JSON response', actions: fallbackActions, raw: text };
    }
    throw new Error(`Failed to parse vision plan JSON: ${error}`);
  }
  const rawActions = Array.isArray(parsed?.actions) ? (parsed.actions as unknown[]) : [];
  const actions = rawActions
    .map((action: unknown) => normalizeInputEvent(action))
    .filter((value): value is InputEvent => Boolean(value));
  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary : undefined,
    actions,
    raw: text,
  };
}

async function resizeImageIfNeeded(imageBuffer: Buffer, maxWidth: number | undefined): Promise<Buffer> {
  if (!maxWidth) return imageBuffer;
  const dims = readPngDimensions(imageBuffer);
  if (!dims || dims.width <= maxWidth) return imageBuffer;
  const tmpDir = await mkdtemp(join(tmpdir(), 'vmrc-vision-'));
  const inPath = join(tmpDir, 'input.png');
  const outPath = join(tmpDir, 'output.png');
  try {
    await writeFile(inPath, imageBuffer);
    try {
      await execFileAsync('magick', [inPath, '-resize', `${maxWidth}`, outPath]);
    } catch (error) {
      await execFileAsync('convert', [inPath, '-resize', `${maxWidth}`, outPath]);
    }
    return await readFile(outPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function runVisionPlan(imageBuffer: Buffer, prompt: string, options: VisionPlanOptions, logger: PluginContext['logger']): Promise<VisionActionPlan> {
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const systemPrompt = options.systemPrompt ?? DEFAULT_VISION_SYSTEM_PROMPT;
  const baseUrl = resolveOllamaBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;
  const temperature = options.temperature;
  const maxTokens = options.maxTokens;
  const resized = await resizeImageIfNeeded(imageBuffer, options.maxImageWidth ?? 1024);

  const payload: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt, images: [resized.toString('base64')] },
    ],
  };

  if (temperature !== undefined || maxTokens !== undefined) {
    payload.options = {};
    if (temperature !== undefined) (payload.options as Record<string, unknown>).temperature = temperature;
    if (maxTokens !== undefined) (payload.options as Record<string, unknown>).num_predict = maxTokens;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama vision request failed (${response.status}): ${body}`);
    }
    const rawText = await response.text();
    let data: any = undefined;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = undefined;
    }
    let content = data?.message?.content ?? data?.response ?? rawText ?? '';

    if (!content) {
      // Fallback to /api/generate for models that don't emit chat-style content
      const genPayload: Record<string, unknown> = {
        model,
        stream: false,
        prompt: `${systemPrompt}\n${prompt}`,
        images: [resized.toString('base64')],
      };
      if (temperature !== undefined || maxTokens !== undefined) {
        genPayload.options = {};
        if (temperature !== undefined) (genPayload.options as Record<string, unknown>).temperature = temperature;
        if (maxTokens !== undefined) (genPayload.options as Record<string, unknown>).num_predict = maxTokens;
      }
      const genResp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(genPayload),
        signal: controller.signal,
      });
      const genText = await genResp.text();
      try {
        const genJson = JSON.parse(genText);
        content = genJson?.response ?? genText ?? '';
      } catch {
        content = genText ?? '';
      }
    }

    if (!content) {
      throw new Error(`Ollama vision response missing content (raw length: ${rawText?.length ?? 0})`);
    }
    return parseVisionPlan(content);
  } catch (error) {
    logger.error('Vision planning failed', { error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runTesseract(
  imageBuffer: Buffer,
  { language = 'eng', psm = 6, oem, extraArgs = [] }: OCRSnapshotOptions = {}
): Promise<OCRResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'vmrc-ocr-'));
  const imagePath = join(tmpDir, 'frame.png');
  try {
    await writeFile(imagePath, imageBuffer);
    const args = [
      imagePath,
      'stdout',
      '-l',
      language,
      '--psm',
      String(psm),
    ];
    if (typeof oem === 'number') {
      args.push('--oem', String(oem));
    }
    args.push('tsv');
    args.push(...extraArgs);

    const { stdout } = await execFileAsync('tesseract', args, { maxBuffer: 10 * 1024 * 1024 });
    const lines = stdout.trim().split(/\r?\n/);
    const header = lines.shift();
    if (!header || !header.startsWith('level')) {
      throw new Error('Unexpected tesseract TSV output');
    }

    const words: OCRWord[] = [];
    const lineMap = new Map<string, OCRLine>();

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 12) continue;
      const level = Number(parts[0]);
      const block = Number(parts[2]);
      const paragraph = Number(parts[3]);
      const lineNum = Number(parts[4]);
      const wordNum = Number(parts[5]);
      const left = Number(parts[6]);
      const top = Number(parts[7]);
      const width = Number(parts[8]);
      const height = Number(parts[9]);
      const confidence = Number(parts[10]);
      const text = parts.slice(11).join('\t');

      if (!text) continue;

      if (level === 5) {
        words.push({
          text,
          bbox: { x: left, y: top, width, height },
          confidence: isNaN(confidence) ? undefined : confidence,
          block,
          paragraph,
          line: lineNum,
          word: wordNum,
        });
      }

      if (level === 4 || level === 5) {
        const key = `${block}-${paragraph}-${lineNum}`;
        const existing = lineMap.get(key);
        if (!existing) {
          lineMap.set(key, {
            text,
            bbox: { x: left, y: top, width, height },
            confidence: isNaN(confidence) ? undefined : confidence,
            block,
            paragraph,
            line: lineNum,
          });
        } else if (level === 5) {
          existing.text = `${existing.text} ${text}`.trim();
          const right = Math.max(existing.bbox.x + existing.bbox.width, left + width);
          const bottom = Math.max(existing.bbox.y + existing.bbox.height, top + height);
          existing.bbox.x = Math.min(existing.bbox.x, left);
          existing.bbox.y = Math.min(existing.bbox.y, top);
          existing.bbox.width = right - existing.bbox.x;
          existing.bbox.height = bottom - existing.bbox.y;
          if (existing.confidence !== undefined && !isNaN(confidence)) {
            existing.confidence = (existing.confidence + confidence) / 2;
          }
        }
      }
    }

    const ocrLines = Array.from(lineMap.values()).sort((a, b) => {
      if (a.block === b.block) {
        if (a.paragraph === b.paragraph) return (a.line ?? 0) - (b.line ?? 0);
        return (a.paragraph ?? 0) - (b.paragraph ?? 0);
      }
      return (a.block ?? 0) - (b.block ?? 0);
    });

    const text = ocrLines.map((line) => line.text).join('\n');
    const dimensions = readPngDimensions(imageBuffer) ?? { width: 0, height: 0 };

    return {
      text,
      lines: ocrLines,
      words,
      width: dimensions.width,
      height: dimensions.height,
      timestamp: Date.now(),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function findTextMatches(
  ocr: OCRResult,
  query: string | RegExp,
  options: FindTextOptions = {}
): OCRMatch[] {
  const { matchCase = false, scope = 'line' } = options;
  const matches: OCRMatch[] = [];
  const needle = typeof query === 'string' ? normalizeText(query, matchCase) : query;

  const checkText = (text: string): boolean => {
    if (typeof needle === 'string') {
      return normalizeText(text, matchCase).includes(needle);
    }
    return needle.test(text);
  };

  const includeLine = scope === 'line' || scope === 'all';
  const includeWord = scope === 'word' || scope === 'all';

  if (includeLine) {
    for (const line of ocr.lines) {
      if (checkText(line.text)) {
        matches.push({
          text: line.text,
          bbox: line.bbox,
          confidence: line.confidence,
          level: 'line',
          block: line.block,
          paragraph: line.paragraph,
          line: line.line,
        });
      }
    }
  }

  if (includeWord) {
    for (const word of ocr.words) {
      if (checkText(word.text)) {
        matches.push({
          text: word.text,
          bbox: word.bbox,
          confidence: word.confidence,
          level: 'word',
          block: word.block,
          paragraph: word.paragraph,
          line: word.line,
          word: word.word,
        });
      }
    }
  }

  return matches;
}

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

class VncDriver implements BackendDriver {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string | undefined,
    private readonly logger: PluginContext['logger']
  ) {}

  private async runVncdo(args: string[]): Promise<void> {
    const baseArgs = ['-s', `${this.host}::${this.port}`];
    if (this.password) {
      baseArgs.push('-p', this.password);
    }
    await execFileAsync('/home/monad/.local/bin/vncdo', [...baseArgs, ...args]);
  }

  async connect(): Promise<void> {
    this.logger.info('VNC session connected', { host: this.host, port: this.port });
  }

  async disconnect(): Promise<void> {
    this.logger.info('VNC session disconnected', { host: this.host, port: this.port });
  }

  async captureFrame(): Promise<Frame> {
    const filePath = `/tmp/vmrc_vnc_${this.host.replace(/\W/g, '_')}_${this.port}.png`;
    const display = Math.max(0, this.port - 5900);
    const target = `${this.host}:${display}`;
    const args = ['-quiet', target, filePath];
    await execFileAsync('vncsnapshot', args);
    const buffer = await readFile(filePath);
    const detected = readPngDimensions(buffer) ?? DEFAULT_VIEWPORT;
    return {
      buffer,
      mimeType: 'image/png',
      width: detected.width,
      height: detected.height,
      timestamp: Date.now(),
    };
  }

  async sendInput(event: InputEvent): Promise<void> {
    switch (event.type) {
      case 'key': {
        if (event.action !== 'down') return;
        const modifiers = (event.modifiers ?? []).map((m) => m.toLowerCase());
        const key = event.key.toLowerCase();
        const combo = modifiers.length ? `${modifiers.join('+')}+${key}` : key;
        await this.runVncdo(['key', combo]);
        return;
      }
      case 'text': {
        await this.runVncdo(['type', event.text]);
        return;
      }
      case 'mouse-move': {
        await this.runVncdo(['mousemove', String(Math.round(event.x)), String(Math.round(event.y))]);
        return;
      }
      case 'mouse-button': {
        const button = event.button === 'left' ? '1' : event.button === 'right' ? '3' : '2';
        if (event.action === 'down') {
          await this.runVncdo(['mousedown', button]);
        } else {
          await this.runVncdo(['mouseup', button]);
        }
        return;
      }
      case 'mouse-scroll': {
        const deltaY = event.deltaY ?? 0;
        if (deltaY > 0) {
          await this.runVncdo(['click', '5']);
        } else if (deltaY < 0) {
          await this.runVncdo(['click', '4']);
        }
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
    this.logger.warn('VNC clipboard not supported; typing text instead');
    await this.runVncdo(['type', text]);
  }

  async setViewport(): Promise<void> {
    // VNC viewport handled by server; no-op.
  }

  async healthCheck(): Promise<boolean> {
    return true;
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

const QMP_KEY_ALIASES: Record<string, string> = {
  enter: 'ret',
  return: 'ret',
  tab: 'tab',
  esc: 'esc',
  escape: 'esc',
  backspace: 'backspace',
  space: 'spc',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  shift: 'shift',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  meta: 'meta',
  dot: 'dot',
  '.': 'dot',
  '-': 'minus',
  minus: 'minus',
  '=': 'equal',
  equal: 'equal',
  '/': 'slash',
  slash: 'slash',
  ',': 'comma',
  comma: 'comma',
};

function keyToQmp(key: string): string | null {
  if (!key) return null;
  const normalized = key.toLowerCase();
  if (QMP_KEY_ALIASES[normalized]) return QMP_KEY_ALIASES[normalized];
  if (normalized.length === 1) {
    if (normalized >= 'a' && normalized <= 'z') return normalized;
    if (normalized >= '0' && normalized <= '9') return normalized;
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
    private readonly absoluteMouse: boolean,
    private readonly inputRetryCount: number,
    private readonly inputRetryDelayMs: number,
    private readonly useGuestScreenshot: boolean,
    private readonly guestScreenshotPath: string
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

  private async runQga(command: Record<string, unknown>): Promise<any> {
    const { stdout } = await execFileAsync('virsh', ['qemu-agent-command', this.domain, JSON.stringify(command)]);
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  }

  private async captureGuestScreenshot(): Promise<Buffer> {
    const path = this.guestScreenshotPath;
    const ps = `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$w = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width; ` +
      `$h = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height; ` +
      `$b = New-Object System.Drawing.Bitmap($w, $h); ` +
      `$g = [System.Drawing.Graphics]::FromImage($b); ` +
      `$g.CopyFromScreen([System.Windows.Forms.SystemInformation]::VirtualScreen.X, [System.Windows.Forms.SystemInformation]::VirtualScreen.Y, 0, 0, $b.Size); ` +
      `$targetW = 800; ` +
      `$scale = [Math]::Min(1.0, $targetW / $w); ` +
      `$newW = [int]($w * $scale); ` +
      `$newH = [int]($h * $scale); ` +
      `$b2 = New-Object System.Drawing.Bitmap($b, $newW, $newH); ` +
      `$ms = New-Object IO.MemoryStream; ` +
      `$b2.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); ` +
      `[Convert]::ToBase64String($ms.ToArray())`;

    const execResp = await this.runQga({
      execute: 'guest-exec',
      arguments: {
        path: 'powershell.exe',
        arg: ['-NoProfile', '-NonInteractive', '-Command', ps],
        'capture-output': true,
      },
    });

    const pid = execResp?.return?.pid;
    if (!pid) {
      throw new Error('guest-exec did not return pid');
    }

    // Wait for completion
    let outData: string | undefined;
    for (let i = 0; i < 20; i++) {
      const status = await this.runQga({
        execute: 'guest-exec-status',
        arguments: { pid },
      });
      if (status?.return?.out_data) {
        outData = status.return.out_data;
      }
      if (status?.return?.exited) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (outData) {
      const stdout = Buffer.from(outData, 'base64').toString('utf8').trim();
      if (stdout) {
        return Buffer.from(stdout, 'base64');
      }
    }

    // Fallback: read file via guest-file-read
    const readFileOnce = async (): Promise<Buffer> => {
      const open = await this.runQga({
        execute: 'guest-file-open',
        arguments: { path, mode: 'r' },
      });
      const handle = open?.return;
      if (!handle) throw new Error('guest-file-open failed');

      const chunks: Buffer[] = [];
      while (true) {
        const read = await this.runQga({
          execute: 'guest-file-read',
          arguments: { handle, count: 65536 },
        });
        const buf = read?.return?.buf_b64;
        const count = read?.return?.count ?? 0;
        if (buf) chunks.push(Buffer.from(buf, 'base64'));
        if (!count || count === 0) break;
      }

      await this.runQga({
        execute: 'guest-file-close',
        arguments: { handle },
      });

      return Buffer.concat(chunks);
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const buffer = await readFileOnce();
      const signatureOk = buffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
      if (signatureOk && buffer.length > 1024) return buffer;
      await new Promise((r) => setTimeout(r, 300));
    }

    return await readFileOnce();
  }

  private async runWithRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= this.inputRetryCount) {
          throw error;
        }
        attempt += 1;
        this.logger.warn(`${label} failed; retrying`, { attempt, error });
        if (this.inputRetryDelayMs > 0) {
          await sleep(this.inputRetryDelayMs);
        }
      }
    }
  }

  private async sendQmpEvents(events: Array<Record<string, unknown>>): Promise<void> {
    await this.runWithRetry(
      () => this.runQmp({ execute: 'input_send_event', arguments: { events } }),
      'QMP input'
    );
  }

  private async sendKeyEvents(events: Array<{ key: string; down: boolean }>): Promise<void> {
    const qmpEvents = events.map((event) => ({
      type: 'key',
      data: { down: event.down, key: { type: 'qcode', data: event.key } },
    }));
    await this.sendQmpEvents(qmpEvents);
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
    let buffer: Buffer;
    if (this.useGuestScreenshot) {
      buffer = await this.captureGuestScreenshot();
    } else {
      const filePath = `/tmp/vmrc_${this.domain}.png`;
      await this.runVirsh(['screenshot', this.domain, '--file', filePath]);
      buffer = await readFile(filePath);
    }
    const detected = readPngDimensions(buffer);
    const targetViewport = detected ?? viewport ?? DEFAULT_VIEWPORT;
    if (detected) {
      this.viewport = detected;
    }
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
        const key = keyToQmp(event.key);
        if (!key) {
          this.logger.warn('Unsupported key', { key: event.key });
          return;
        }
        const modifierKeys = (event.modifiers ?? [])
          .map((modifier) => keyToQmp(modifier))
          .filter((value): value is string => Boolean(value));

        const keyEvents = event.action === 'down'
          ? [...modifierKeys.map((mod) => ({ key: mod, down: true })), { key, down: true }]
          : [{ key, down: false }, ...modifierKeys.map((mod) => ({ key: mod, down: false }))];

        try {
          await this.sendKeyEvents(keyEvents);
        } catch (error) {
          if (event.action === 'down') {
            const fallbackKey = keyToVirsh(event.key);
            const fallbackMods = (event.modifiers ?? [])
              .map((modifier) => keyToVirsh(modifier))
              .filter((value): value is string => Boolean(value));
            if (fallbackKey) {
              await this.runWithRetry(
                () => this.runVirsh(['send-key', this.domain, ...fallbackMods, fallbackKey]),
                'virsh send-key'
              );
              return;
            }
          }
          throw error;
        }
        return;
      }
      case 'text': {
        for (const char of event.text) {
          const qmpKey = keyToQmp(char);
          if (qmpKey) {
            await this.sendKeyEvents([{ key: qmpKey, down: true }, { key: qmpKey, down: false }]);
            continue;
          }
          const key = keyToVirsh(char);
          if (key) {
            await this.runWithRetry(
              () => this.runVirsh(['send-key', this.domain, key]),
              'virsh send-key'
            );
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
          await this.sendQmpEvents([
            { type: 'abs', data: { axis: 'x', value: absX } },
            { type: 'abs', data: { axis: 'y', value: absY } },
          ]);
          return;
        }
        const dx = Math.round(event.x - this.mouseX);
        const dy = Math.round(event.y - this.mouseY);
        this.mouseX = event.x;
        this.mouseY = event.y;
        await this.runWithRetry(
          () => this.runVirsh(['qemu-monitor-command', '--hmp', this.domain, `mouse_move ${dx} ${dy}`]),
          'HMP mouse_move'
        );
        return;
      }
      case 'mouse-button': {
        if (typeof event.x === 'number' && typeof event.y === 'number') {
          await this.sendInput({ type: 'mouse-move', x: event.x, y: event.y });
        }
        if (this.absoluteMouse) {
          await this.sendQmpEvents([
            {
              type: 'btn',
              data: {
                button: event.button === 'left' ? 'left' : event.button === 'right' ? 'right' : 'middle',
                down: event.action === 'down',
              },
            },
          ]);
          return;
        }
        const bit = event.button === 'left' ? 1 : event.button === 'right' ? 2 : 4;
        if (event.action === 'down') {
          this.mouseMask |= bit;
        } else {
          this.mouseMask &= ~bit;
        }
        await this.runWithRetry(
          () => this.runVirsh(['qemu-monitor-command', '--hmp', this.domain, `mouse_button ${this.mouseMask}`]),
          'HMP mouse_button'
        );
        return;
      }
      case 'mouse-scroll': {
        const deltaX = Math.round(event.deltaX ?? 0);
        const deltaY = Math.round(event.deltaY ?? 0);
        const events: Array<Record<string, unknown>> = [];
        if (deltaY !== 0) {
          events.push({ type: 'rel', data: { axis: 'wheel', value: deltaY } });
        }
        if (deltaX !== 0) {
          events.push({ type: 'rel', data: { axis: 'hwheel', value: deltaX } });
        }
        if (!events.length) return;
        await this.sendQmpEvents(events);
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
    try {
      await this.runQga({
        execute: 'guest-set-clipboard',
        arguments: { text },
      });
      this.logger.debug('Clipboard set via guest agent', { length: text.length });
      return;
    } catch (error) {
      this.logger.warn('Clipboard set via guest agent failed; falling back to keystrokes', {
        length: text.length,
        error,
      });
    }

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
    private readonly visionOptions: VMRemoteControlOptions['vision'] | undefined,
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
    const frame = await this.driver.captureFrame(this.viewport);
    if (frame.width !== this.viewport.width || frame.height !== this.viewport.height) {
      this.viewport = { width: frame.width, height: frame.height };
    }
    return frame;
  }

  async ocrSnapshot(options?: OCRSnapshotOptions): Promise<OCRResult> {
    const frame = await this.snapshot();
    const ocr = await runTesseract(frame.buffer, options);
    return {
      ...ocr,
      width: frame.width,
      height: frame.height,
    };
  }

  async findText(query: string | RegExp, options?: FindTextOptions): Promise<OCRMatch[]> {
    const ocr = await this.ocrSnapshot();
    return findTextMatches(ocr, query, options);
  }

  async visionPlan(prompt: string, options: VisionPlanOptions = {}): Promise<VisionActionPlan> {
    const frame = await this.snapshot();
    const merged: VisionPlanOptions = {
      model: options.model ?? this.visionOptions?.model,
      baseUrl: options.baseUrl ?? this.visionOptions?.base_url,
      systemPrompt: options.systemPrompt ?? this.visionOptions?.system_prompt,
      temperature: options.temperature ?? this.visionOptions?.temperature,
      maxTokens: options.maxTokens ?? this.visionOptions?.max_tokens,
      timeoutMs: options.timeoutMs ?? this.visionOptions?.timeout_ms,
      maxImageWidth: options.maxImageWidth ?? this.visionOptions?.max_image_width,
    };
    const instruction = prompt || options.prompt || 'Suggest the next UI action.';
    return runVisionPlan(frame.buffer, instruction, merged, this.logger);
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

    if (backend !== 'mock' && backend !== 'spice' && backend !== 'vnc') {
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
      this.options.vision,
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
          const inputRetryCount = this.options.spice?.input_retry_count ?? 2;
          const inputRetryDelayMs = this.options.spice?.input_retry_delay_ms ?? 60;
          const useGuestScreenshot = this.options.spice?.use_guest_screenshot ?? false;
          const guestScreenshotPath = this.options.spice?.guest_screenshot_path ?? 'C:\\Windows\\Temp\\vmrc_shot.png';
          return new SpiceVirshDriver(
            domain,
            this.context.logger,
            viewport,
            absoluteMouse,
            inputRetryCount,
            inputRetryDelayMs,
            useGuestScreenshot,
            guestScreenshotPath
          );
        }
        if (backend === 'vnc') {
          const host = this.options.vnc?.host ?? '127.0.0.1';
          const port = this.options.vnc?.port ?? 5901;
          return new VncDriver(host, port, this.options.vnc?.password, this.context.logger);
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
