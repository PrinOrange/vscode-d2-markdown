import * as vscode from 'vscode';
import type { RenderRequestOptions } from './protocol';
import type { D2Service, PrewarmBlock } from './service';
import { extractD2Blocks, normalizeD2Source, SaltTracker } from './blocks';
import { parseD2Info } from './options';

/** Renders kicked off quickly enough to coalesce a burst of keystrokes. */
const DEBOUNCE_MS = 250;

/** Upper bound on diagrams pre-warmed per document, in case one has many. */
const MAX_BLOCKS = 24;

/**
 * Renders diagrams in the background whenever a markdown document changes.
 *
 * This is what makes editing feel immediate: by the time the preview is rebuilt
 * the diagrams are usually already in the cache, so the fence renderer finds a
 * hit and never has to make the user wait. Pre-warming is also where the real
 * work happens for diagrams too slow to finish inside the sync budget.
 */
export class Prewarmer implements vscode.Disposable {
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	#disposed = false;

	constructor(
		private readonly service: D2Service,
		private readonly getDefaults: () => RenderRequestOptions
	) {}

	/** Queue a document for pre-warming, restarting the debounce timer. */
	schedule(document: vscode.TextDocument): void {
		if (this.#disposed || document.languageId !== 'markdown') {
			return;
		}

		const key = document.uri.toString();
		const pending = this.#timers.get(key);
		if (pending) {
			clearTimeout(pending);
		}
		this.#timers.set(
			key,
			setTimeout(() => {
				this.#timers.delete(key);
				this.run(document.getText());
			}, DEBOUNCE_MS)
		);
	}

	/** Pre-warm immediately, skipping the debounce (used when a doc opens). */
	run(text: string): void {
		if (this.#disposed) {
			return;
		}
		this.service.prewarm(this.blocks(text));
	}

	/**
	 * Build the block list exactly as the fence renderer would see it, salts
	 * included - a mismatch here would mean pre-warming never produces a hit.
	 */
	blocks(text: string): PrewarmBlock[] {
		const defaults = this.getDefaults();
		const tracker = new SaltTracker();
		return extractD2Blocks(text)
			.slice(0, MAX_BLOCKS)
			.map(fence => {
				const source = normalizeD2Source(fence.content);
				return {
					source,
					options: {
						...defaults,
						block: parseD2Info(fence.info),
						salt: tracker.next(source),
					},
				};
			});
	}

	dispose(): void {
		this.#disposed = true;
		for (const timer of this.#timers.values()) {
			clearTimeout(timer);
		}
		this.#timers.clear();
	}
}
