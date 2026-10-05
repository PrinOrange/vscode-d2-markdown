/**
 * Worker-thread entry point.
 *
 * A single `D2` instance lives here for the lifetime of the extension so the
 * (large) wasm module is instantiated exactly once, and never on the extension
 * host's own thread.
 *
 * A synchronous request is answered twice over, because the host may have
 * stopped waiting before the answer was ready:
 *
 *  - the `syncPort` copy, followed by the shared flag. The host is parked in
 *    `Atomics.wait` and reads that copy with `receiveMessageOnPort` when it
 *    wakes.
 *  - the `parentPort` copy, delivered on the host's normal message queue. It is
 *    what lets a request the host gave up on still reach its cache, so the
 *    diagram is drawn on a later refresh instead of being rendered again.
 *
 * An asynchronous request is answered on `parentPort` alone.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { D2 } from '@d2lang/d2';
import type {
	RenderRequest,
	RenderResponse,
	WorkerControlMessage,
	WorkerInitData,
} from '../d2/protocol';

const { syncPort, signal } = workerData as WorkerInitData;
const flag = new Int32Array(signal);

if (!parentPort) {
	throw new Error('d2Worker must be started as a worker thread.');
}

const hostPort = parentPort;

let d2: D2 | undefined;

/** Async renders are chained so they never interleave with each other. */
let asyncQueue: Promise<void> = Promise.resolve();

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function render(request: RenderRequest): Promise<RenderResponse> {
	if (!d2) {
		return { id: request.id, ok: false, error: 'The D2 engine is still starting up.' };
	}

	const { compile, render: renderOptions, block, salt, ...modelled } = request.options;
	// Every key of D2's RenderOptions is also a valid CompileOptions key, since
	// CompileOptions extends RenderOptions, so the user-supplied objects can be
	// flattened into one set. Layered least specific to most: the options the
	// extension models, then the two global objects, then the per-block
	// overrides. Render wins over compile where they overlap, which is the
	// direction D2 itself merges them.
	const options = { ...modelled, ...compile, ...renderOptions, ...block };

	// D2 always emits a `@media (prefers-color-scheme: dark)` block holding
	// `darkThemeID`, and a webview's media query is not guaranteed to agree with
	// `workbench.colorTheme` - a light editor on a dark-set OS would come out in
	// dark colours. Pointing the dark theme at the resolved theme makes that
	// block a no-op, leaving the extension's own theme choice in charge. It is
	// set after the user's options so a stray `darkThemeID` cannot undo it.
	const darkThemeID = isFiniteNumber(options.themeID) ? options.themeID : undefined;

	try {
		const compiled = await d2.compile(request.source, { ...options, darkThemeID });

		const output = await d2.render(compiled.diagram, {
			// Options the diagram itself configured still apply; the entries below
			// are the ones this extension always controls.
			...compiled.renderOptions,
			...options,
			// Keeps ids unique when several diagrams share one preview document.
			salt,
			// The output is inlined into HTML, so the XML prolog has to go.
			noXMLTag: true,
			darkThemeID,
		});

		return { id: request.id, ok: true, output: stripXmlProlog(output) };
	} catch (error) {
		return { id: request.id, ok: false, error: toMessage(error) };
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Drop a leading XML prolog.
 *
 * `noXMLTag` covers the ordinary case, but it is not honoured on the animated
 * path (`animateInterval`), which always returns the prolog. Left in, it would
 * become a stray bogus comment in the preview's HTML.
 */
function stripXmlProlog(output: string): string {
	return output.replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*/, '');
}

hostPort.on('message', (request: RenderRequest) => {
	if (request.mode === 'sync') {
		// Don't wait on `asyncQueue` here: the host is parked until the flag goes
		// up, and queueing behind somebody else's render is exactly the case the
		// host's timeout is meant to cover.
		void render(request).then(response => {
			// Publish the payload *before* raising the flag so the host is
			// guaranteed to find it once it wakes up.
			syncPort.postMessage(response);
			Atomics.store(flag, 0, 1);
			Atomics.notify(flag, 0);
			// The host may already have timed out and moved on; this copy is what
			// gets the result into its cache anyway.
			hostPort.postMessage(response);
		});
		return;
	}

	asyncQueue = asyncQueue.then(
		async () => {
			hostPort.postMessage(await render(request));
		},
		() => {
			// Keep the chain usable even if a previous link rejected.
		}
	);
});

async function init(): Promise<void> {
	try {
		d2 = new D2();
		// The first compile is what pays for instantiating the wasm module, so
		// do it now rather than inside somebody's synchronous render.
		await d2.compile('d2Warmup');
		hostPort.postMessage({ kind: 'ready' } satisfies WorkerControlMessage);
	} catch (error) {
		hostPort.postMessage({
			kind: 'fatal',
			error: toMessage(error),
		} satisfies WorkerControlMessage);
	}
}

void init();
