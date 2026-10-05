import * as vscode from 'vscode';

const REFRESH_COMMAND = 'markdown.preview.refresh';

/**
 * Drives `markdown.preview.refresh`, which the built-in markdown extension uses
 * to rebuild the preview even when the document itself has not changed. That is
 * what lets a diagram which finished rendering asynchronously appear in an
 * already-open preview.
 *
 * The command is not part of VS Code's documented extension API, so it is
 * feature detected once and quietly skipped if it ever disappears. Missing it
 * degrades gracefully: the preview still re-renders on the next edit.
 */
export class PreviewRefresher implements vscode.Disposable {
	#timer: ReturnType<typeof setTimeout> | undefined;
	#available: boolean | undefined;
	#disposed = false;

	constructor(private readonly debounceMs: number) {}

	/** Coalesce bursts of finished renders into a single preview rebuild. */
	schedule(): void {
		if (this.#disposed) {
			return;
		}
		if (this.#timer) {
			clearTimeout(this.#timer);
		}
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#run();
		}, this.debounceMs);
	}

	async #run(): Promise<void> {
		if (this.#available === false) {
			return;
		}
		try {
			if (this.#available === undefined) {
				const commands = await vscode.commands.getCommands(true);
				this.#available = commands.includes(REFRESH_COMMAND);
				if (!this.#available) {
					return;
				}
			}
			await vscode.commands.executeCommand(REFRESH_COMMAND);
		} catch (error) {
			this.#available = false;
			console.warn('[vscode-d2] unable to refresh the markdown preview:', error);
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}
}
