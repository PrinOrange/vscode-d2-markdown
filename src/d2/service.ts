import * as path from 'node:path';
import {
	MessageChannel,
	type MessagePort,
	Worker,
	receiveMessageOnPort,
} from 'node:worker_threads';
import {
	isControlMessage,
	type RenderRequestOptions,
	type RenderResponse,
	type WorkerControlMessage,
} from './protocol';
import { stableStringify } from '../util/json';

export type RenderOutcome =
	/** Usually SVG; an `ascii` render returns a text drawing instead. */
	| { readonly kind: 'output'; readonly output: string }
	| { readonly kind: 'error'; readonly error: string }
	/** Not finished yet. The caller should emit a placeholder; a refresh follows. */
	| { readonly kind: 'pending' };

export interface D2ServiceOptions {
	/** How long a synchronous render may block the host, in ms. `0` never blocks. */
	getSyncBudgetMs(): number;
	/** Hard limit on one render before the worker is treated as stuck. */
	getRenderTimeoutMs(): number;
	/** Called when an async render produced something the preview does not have yet. */
	onRendered(): void;
}

/** A block to render ahead of time, so the preview usually gets a cache hit. */
export interface PrewarmBlock {
	readonly source: string;
	readonly options: RenderRequestOptions;
}

const WORKER_FILE = 'd2Worker.js';
const CACHE_CAPACITY = 256;

interface InflightEntry {
	notify: boolean;
	promise: Promise<RenderOutcome>;
}

class LruCache<V> {
	readonly #entries = new Map<string, V>();

	constructor(private readonly capacity: number) {}

	get(key: string): V | undefined {
		const value = this.#entries.get(key);
		if (value !== undefined) {
			// Re-insert so the most recently used keys are the last to be evicted.
			this.#entries.delete(key);
			this.#entries.set(key, value);
		}
		return value;
	}

	set(key: string, value: V): void {
		this.#entries.delete(key);
		this.#entries.set(key, value);
		while (this.#entries.size > this.capacity) {
			const oldest = this.#entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.#entries.delete(oldest.value);
		}
	}

	clear(): void {
		this.#entries.clear();
	}
}

/**
 * Owns the worker thread that hosts D2, and the cache in front of it.
 *
 * Rendering is fundamentally asynchronous, but markdown-it's fence renderer has
 * to return a string *now*. A cache hit satisfies that outright, and pre-warming
 * makes hits the common case. The remaining gap is covered by a deliberately
 * short blocking wait: long enough for an already-warm worker to answer a small
 * diagram, short enough that a pathological one degrades to a placeholder rather
 * than freezing the editor. When the wait is skipped or expires, the abandoned
 * render still reports back over the normal message channel, so the result gets
 * cached and the preview is asked to rebuild.
 */
export class D2Service {
	readonly #cache = new LruCache<RenderOutcome>(CACHE_CAPACITY);
	readonly #pendingAsync = new Map<number, (response: RenderResponse | null) => void>();

	/** Requests the host stopped waiting on; their late responses still get cached. */
	readonly #abandoned = new Map<number, string>();
	readonly #inflight = new Map<string, InflightEntry>();

	#worker: Worker | undefined;
	#syncPort: MessagePort | undefined;
	#signal: Int32Array | undefined;
	#startPromise: Promise<void> | undefined;
	#ready = false;
	#broken = false;
	#disposed = false;
	#nextId = 1;

	constructor(private readonly options: D2ServiceOptions) {}

	//#region lifecycle

	start(): Promise<void> {
		if (this.#ready) {
			return Promise.resolve();
		}
		this.#startPromise ??= this.#spawn();
		return this.#startPromise;
	}

	async #spawn(): Promise<void> {
		this.#teardownWorker();

		const { port1, port2 } = new MessageChannel();
		const signal = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(path.join(__dirname, WORKER_FILE), {
			workerData: { syncPort: port2, signal: signal.buffer },
			transferList: [port2],
		});
		// A referenced worker would keep the extension host alive on shutdown.
		worker.unref();

		this.#worker = worker;
		this.#syncPort = port1;
		this.#signal = signal;

		await new Promise<void>(resolve => {
			let settled = false;
			const finish = (): void => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};

			worker.on('message', (message: WorkerControlMessage | RenderResponse) => {
				this.#handleMessage(message);
				if (isControlMessage(message)) {
					finish();
				}
			});
			worker.on('error', error => {
				console.error('[vscode-d2] worker error:', error);
				this.#broken = true;
				finish();
			});
			worker.on('exit', () => {
				if (this.#worker === worker) {
					this.#ready = false;
					this.#startPromise = undefined;
					if (!this.#disposed) {
						this.#broken = true;
					}
					this.#worker = undefined;
					this.#syncPort = undefined;
					this.#signal = undefined;
					this.#failPendingAsync();
				}
				finish();
			});
		});

		if (!this.#ready) {
			// Let a later render retry rather than caching the failure forever.
			this.#startPromise = undefined;
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		this.#cache.clear();
		this.#failPendingAsync();
		const worker = this.#worker;
		this.#teardownWorker();
		if (worker) {
			try {
				await worker.terminate();
			} catch {
				// Already gone.
			}
		}
	}

	/** Drop every cached diagram, e.g. after a colour theme change. */
	invalidate(): void {
		this.#cache.clear();
	}

	//#endregion

	//#region rendering

	/**
	 * Render for a caller that cannot await. Returns `pending` when the result is
	 * not available within the configured budget.
	 */
	renderSync(source: string, options: RenderRequestOptions): RenderOutcome {
		const key = cacheKey(source, options);
		const cached = this.#cache.get(key);
		if (cached) {
			return cached;
		}

		if (this.#disposed) {
			return { kind: 'error', error: 'The D2 renderer has been shut down.' };
		}

		const budget = this.options.getSyncBudgetMs();
		if (budget <= 0 || !this.#isLive()) {
			// Nothing to wait for, so go async and let a refresh deliver it.
			void this.#startAsync(key, source, options, true);
			return { kind: 'pending' };
		}

		const signal = this.#signal!;
		const worker = this.#worker!;
		const id = this.#nextId++;

		Atomics.store(signal, 0, 0);
		worker.postMessage({ id, mode: 'sync', source, options });

		if (Atomics.wait(signal, 0, 0, budget) === 'timed-out') {
			// Deliberately not re-issuing the render: the worker is still working
			// on it and its response will arrive over the message channel, which
			// caches it and asks the preview to rebuild.
			this.#abandoned.set(id, key);
			return { kind: 'pending' };
		}

		const response = this.#takeSyncResponse(id);
		if (!response) {
			this.#recycleWorker();
			return { kind: 'error', error: 'The D2 renderer returned an unreadable response.' };
		}
		return this.#accept(key, response);
	}

	/** Render without blocking anything, for pre-warming and for async callers. */
	prewarm(blocks: readonly PrewarmBlock[]): void {
		for (const block of blocks) {
			const key = cacheKey(block.source, block.options);
			if (this.#cache.get(key)) {
				continue;
			}
			void this.#startAsync(key, block.source, block.options, false);
		}
	}

	#startAsync(
		key: string,
		source: string,
		options: RenderRequestOptions,
		notify: boolean
	): Promise<RenderOutcome> {
		const existing = this.#inflight.get(key);
		if (existing) {
			// Another caller already asked for this exact diagram. Only one render
			// happens, but a refresh is still owed if anybody is waiting on one.
			existing.notify ||= notify;
			return existing.promise;
		}

		const entry = { notify } as InflightEntry;
		entry.promise = this.#renderOnce(key, source, options, entry).finally(() => {
			this.#inflight.delete(key);
		});
		this.#inflight.set(key, entry);
		return entry.promise;
	}

	async #renderOnce(
		key: string,
		source: string,
		options: RenderRequestOptions,
		entry: InflightEntry
	): Promise<RenderOutcome> {
		await this.start();

		if (this.#disposed) {
			return { kind: 'error', error: 'The D2 renderer has been shut down.' };
		}
		if (!this.#isLive()) {
			// The worker is started again on the next attempt, so this is a
			// report rather than a dead end - the cause is in the host log.
			return {
				kind: 'error',
				error: this.#broken
					? 'The D2 renderer failed to start. See the Extension Host log for details.'
					: 'The D2 renderer is unavailable.',
			};
		}

		const id = this.#nextId++;
		const response = await new Promise<RenderResponse | null>(resolve => {
			// Any resolution - a response, a worker exit, or the timeout below -
			// retires the timer along with the entry.
			const settle = (value: RenderResponse | null): void => {
				clearTimeout(timeout);
				resolve(value);
			};
			const timeout = setTimeout(() => {
				if (this.#pendingAsync.delete(id)) {
					// The worker is not coming back. Drop it so the next attempt
					// gets a fresh thread instead of queueing behind this one.
					this.#recycleWorker();
					settle(null);
				}
			}, this.options.getRenderTimeoutMs());

			this.#pendingAsync.set(id, settle);
			this.#worker!.postMessage({ id, mode: 'async', source, options });
		});

		if (!response) {
			// The worker went away mid-render; not worth caching.
			return { kind: 'error', error: 'The D2 renderer stopped unexpectedly.' };
		}

		const outcome = this.#accept(key, response);
		if (entry.notify) {
			this.options.onRendered();
		}
		return outcome;
	}

	#accept(key: string, response: RenderResponse): RenderOutcome {
		const outcome: RenderOutcome = response.ok
			? { kind: 'output', output: response.output }
			: { kind: 'error', error: response.error };
		// Errors are cached too: they are real compile errors, and remembering
		// them stops a broken diagram from re-rendering (and re-refreshing) on
		// every keystroke.
		this.#cache.set(key, outcome);
		return outcome;
	}

	//#endregion

	//#region internals

	#isLive(): boolean {
		return (
			this.#ready &&
			!this.#broken &&
			this.#worker !== undefined &&
			this.#syncPort !== undefined &&
			this.#signal !== undefined
		);
	}

	#handleMessage(message: WorkerControlMessage | RenderResponse): void {
		if (isControlMessage(message)) {
			if (message.kind === 'ready') {
				this.#ready = true;
				this.#broken = false;
			} else {
				this.#broken = true;
				console.error('[vscode-d2] worker failed to start:', message.error);
			}
			return;
		}

		const resolve = this.#pendingAsync.get(message.id);
		if (resolve) {
			this.#pendingAsync.delete(message.id);
			resolve(message);
			return;
		}

		this.#settleLate(message);
	}

	/**
	 * File a response nobody is waiting on. A synchronous request that the host
	 * gave up waiting for arrives twice: once on the sync channel and once on the
	 * normal message queue. Whichever is read first wins, and the refresh it
	 * triggers is what replaces the placeholder the caller had to emit.
	 */
	#settleLate(response: RenderResponse): void {
		const key = this.#abandoned.get(response.id);
		if (key === undefined) {
			return;
		}
		this.#abandoned.delete(response.id);
		this.#accept(key, response);
		this.options.onRendered();
	}

	/**
	 * Read the response for `id` off the sync channel, filing anything the host
	 * is no longer waiting for rather than dropping it.
	 */
	#takeSyncResponse(id: number): RenderResponse | undefined {
		const port = this.#syncPort;
		if (!port) {
			return undefined;
		}
		for (;;) {
			const received = receiveMessageOnPort(port);
			if (!received) {
				return undefined;
			}
			const response = received.message as RenderResponse;
			if (response.id === id) {
				return response;
			}
			this.#settleLate(response);
		}
	}

	#failPendingAsync(): void {
		for (const resolve of this.#pendingAsync.values()) {
			resolve(null);
		}
		this.#pendingAsync.clear();
		this.#abandoned.clear();
	}

	/** Drop a wedged worker; `start()` will build a fresh one on demand. */
	#recycleWorker(): void {
		this.#ready = false;
		this.#broken = true;
		this.#startPromise = undefined;
		this.#failPendingAsync();
		this.#teardownWorker();
		void this.start().catch(() => {
			// `start()` records the failure in `#broken`.
		});
	}

	#teardownWorker(): void {
		const worker = this.#worker;
		this.#worker = undefined;
		this.#syncPort = undefined;
		this.#signal = undefined;
		this.#ready = false;
		if (worker) {
			worker.removeAllListeners();
			void worker.terminate().catch(() => {
				// Already gone.
			});
		}
	}

	//#endregion
}

/**
 * Salt is part of the key on purpose: two occurrences of the same diagram need
 * different salts so their SVG element ids cannot collide.
 *
 * The free-form option objects are serialised with sorted keys, because two
 * settings objects that differ only in the order their keys were written are
 * the same options and should share a cache entry.
 */
function cacheKey(source: string, options: RenderRequestOptions): string {
	return [
		stableStringify(options.compile ?? {}),
		stableStringify(options.render ?? {}),
		stableStringify(options.block ?? {}),
		source,
		options.themeID,
		options.layout,
		options.sketch,
		options.pad,
		options.center,
		options.scale,
		options.salt,
	].join(' ');
}
