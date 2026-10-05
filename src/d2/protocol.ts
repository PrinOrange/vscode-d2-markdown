import type { MessagePort } from 'node:worker_threads';

/** Layout engines D2 ships with. */
export type D2Layout = 'dagre' | 'elk' | 'tala';

/** Free-form D2 options, as written by the user in settings. */
export type CustomOptions = Readonly<Record<string, unknown>>;

/**
 * The options for one render. Plain JSON, so it can cross the worker boundary
 * and be used as a cache key.
 *
 * The named fields are the ones the extension models itself, through dedicated
 * settings and fence info strings. `compile` and `render` carry everything else
 * the user wrote in `d2.compileOptions` / `d2.renderOptions`, forwarded to D2
 * untouched.
 */
export interface RenderRequestOptions {
	/**
	 * The one concrete theme to draw with. There is deliberately no separate
	 * dark theme here: D2 always emits a `prefers-color-scheme` block holding
	 * whatever `darkThemeID` says, and a webview's media query is not guaranteed
	 * to agree with `workbench.colorTheme`. The extension resolves light/dark
	 * itself and re-renders on a theme change instead.
	 */
	themeID?: number;
	layout?: D2Layout;
	sketch?: boolean;
	pad?: number;
	center?: boolean;
	scale?: number;
	/** Appended to every id inside the SVG so several diagrams can share one document. */
	salt?: string;
	/** Forwarded to `d2.compile()`. */
	compile?: CustomOptions;
	/** Forwarded to `d2.render()`, and takes precedence over `compile` where both set a key. */
	render?: CustomOptions;
	/**
	 * Overrides read from a fence info string. Kept apart from the fields above
	 * because a per-block option is the most specific layer and has to be
	 * applied after the global ones, not before them.
	 */
	block?: CustomOptions;
}

/**
 * `sync` requests are answered over the transferred `syncPort` so the extension
 * host can pick the result up with `receiveMessageOnPort` while it is blocked in
 * `Atomics.wait`. `async` requests (pre-warming) are answered over `parentPort`
 * so nothing has to block.
 */
export type RenderMode = 'sync' | 'async';

export interface RenderRequest {
	id: number;
	mode: RenderMode;
	source: string;
	options: RenderRequestOptions;
}

/**
 * `output` is usually an SVG, but `ascii: true` makes D2 return a text drawing
 * instead, so the field is named for what it is rather than for the common case.
 */
export type RenderResponse =
	| { id: number; ok: true; output: string }
	| { id: number; ok: false; error: string };

/** Worker -> host lifecycle messages, sent over `parentPort`. */
export type WorkerControlMessage =
	| { kind: 'ready' }
	| { kind: 'fatal'; error: string };

/** `workerData` handed to the worker thread. */
export interface WorkerInitData {
	syncPort: MessagePort;
	signal: SharedArrayBuffer;
}

export function isControlMessage(
	message: WorkerControlMessage | RenderResponse
): message is WorkerControlMessage {
	return 'kind' in message;
}
