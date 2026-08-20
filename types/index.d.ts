// Type definitions for supercomment
// Project: https://github.com/UstaLabs/supercomment

export interface SupercommentConfig {
  /** Where to POST reports. Unset means clipboard/download fallback. */
  endpoint?: string | null;
  /** Free-form label carried in every payload. Defaults to location.host. */
  project?: string;
  /** Element-picker hotkey, e.g. "ctrl+shift+k". `ctrl` also matches Cmd. */
  hotkey?: string;
  /** Page-report hotkey. */
  pageHotkey?: string;
  /** Start/stop recording hotkey. */
  recordHotkey?: string;
  /** Show the floating launcher button. */
  button?: boolean;
  captureConsole?: boolean;
  captureNetwork?: boolean;
  captureErrors?: boolean;
  /** Which response bodies to keep. */
  captureBodies?: 'errors' | 'always' | 'never';
  /** Screenshot checkbox: shown-and-off, shown-and-on, or hidden. */
  screenshot?: 'ask' | 'on' | 'off';
  /**
   * Which capture groups arrive pre-selected in the composer.
   * Recorded steps are always pre-selected regardless.
   */
  include?: 'none' | 'all';
  maxLogs?: number;
  maxNetwork?: number;
  maxErrors?: number;
  maxBody?: number;
  theme?: 'dark' | 'light';
  /** Custom transport. Overrides `endpoint` entirely. */
  onSend?: ((payload: Report) => void | Promise<unknown>) | null;
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** Milliseconds since the library initialised. */
  t: number;
  at: string;
  text: string;
}

export interface NetworkEntry {
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  t: number;
  at: string;
  status: number | null;
  ok: boolean | null;
  ms: number | null;
  requestBody?: string;
  responseBody?: string;
  error?: string;
}

export interface ErrorEntry {
  kind: 'error' | 'unhandledrejection' | 'resource';
  t: number;
  at: string;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string | null;
}

export type StepType = 'click' | 'input' | 'select' | 'key' | 'scroll' | 'submit' | 'navigate' | 'resize';

export interface Step {
  type: StepType;
  t: number;
  at: string;
  selector?: string | null;
  label?: string;
  /** Masked to bullets for password, data-sc-mask, and card/OTP fields. */
  value?: string;
  tag?: string;
  key?: string;
  url?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface ElementInfo {
  selector: string;
  tag: string;
  id: string | null;
  classes: string | null;
  text: string;
  html: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
}

export interface PageInfo {
  url: string;
  path: string;
  title: string;
  referrer: string | null;
  viewport: { w: number; h: number; dpr: number };
  scroll: { x: number; y: number };
  userAgent: string;
  language: string;
}

export interface Report {
  id: string;
  v: string;
  type: 'element' | 'page' | 'recording';
  project: string;
  createdAt: string;
  comment: string;
  page: PageInfo;
  element: ElementInfo | null;
  screenshot: string | null;
  steps: Step[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: ErrorEntry[];
}

export interface Snapshot {
  page: PageInfo;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: ErrorEntry[];
  steps: Step[];
}

export interface Supercomment {
  readonly version: string;
  readonly config: SupercommentConfig;
  /** Open the composer, optionally targeting an element. */
  open(el?: Element | null): void;
  /** Enter element-picking mode. */
  pick(): void;
  /** Leave element-picking mode. */
  cancel(): void;
  /** Toggle the mode menu. */
  menu(): void;
  /** Start recording user actions. */
  record(): void;
  /** Stop recording. Pass false to skip opening the composer. */
  stop(openComposer?: boolean): void;
  /** Recording state, or null when not recording. */
  recording(): { since: number; steps: number } | null;
  /** The steps recorded so far. */
  steps(): Step[];
  /** Send a report with no UI. */
  report(
    comment: string,
    opts?: {
      element?: Element | null;
      screenshot?: string | null;
      steps?: false;
      console?: false;
      network?: false;
      errors?: false;
    }
  ): Promise<{ id: string; via: string }>;
  /** Everything currently buffered. */
  snapshot(): Snapshot;
  /** Capture the tab via getDisplayMedia. Requires a user gesture. */
  screenshot(): Promise<string>;
  /** Empty the capture buffers. */
  clear(): void;
}

declare global {
  interface Window {
    supercomment: Supercomment;
    SUPERCOMMENT_CONFIG?: SupercommentConfig;
  }
}

declare const supercomment: Supercomment;
export default supercomment;
