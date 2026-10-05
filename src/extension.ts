import * as vscode from 'vscode';
import { readDefaultOptions, readRenderTimeoutMs, readSyncBudgetMs } from './d2/config';
import { Prewarmer } from './d2/prewarm';
import { PreviewRefresher } from './d2/refresh';
import { D2Service } from './d2/service';
import { markdownItD2, type MarkdownIt } from './markdownItPlugin';

/** How long finished renders are batched before the preview is rebuilt. */
const REFRESH_DEBOUNCE_MS = 150;

export interface D2PluginExports {
	extendMarkdownIt(md: MarkdownIt): MarkdownIt;
}

/** Kept module-level so `deactivate` can shut the worker thread down. */
let service: D2Service | undefined;

export function activate(context: vscode.ExtensionContext): D2PluginExports {
	const refresher = new PreviewRefresher(REFRESH_DEBOUNCE_MS);
	const d2Service = new D2Service({
		getSyncBudgetMs: readSyncBudgetMs,
		getRenderTimeoutMs: readRenderTimeoutMs,
		onRendered: () => refresher.schedule(),
	});
	service = d2Service;

	const prewarmer = new Prewarmer(d2Service, readDefaultOptions);

	// Start the worker immediately. Instantiating the wasm module is the slow
	// part of the first render, and doing it here lets that overlap with the user
	// opening a preview instead of holding up the first diagram.
	void d2Service.start().catch(() => {
		// The failure is recorded on the service, and renders report it inline.
	});

	const reset = (): void => {
		// Diagram colours are baked into the SVG, so every cached diagram becomes
		// stale when the theme or the D2 settings change.
		d2Service.invalidate();
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.languageId === 'markdown') {
				prewarmer.run(editor.document.getText());
			}
		}
		refresher.schedule();
	};

	context.subscriptions.push(
		{ dispose: () => void d2Service.dispose() },
		refresher,
		prewarmer,
		vscode.workspace.onDidChangeTextDocument(event => prewarmer.schedule(event.document)),
		vscode.workspace.onDidOpenTextDocument(document => {
			if (document.languageId === 'markdown') {
				prewarmer.run(document.getText());
			}
		}),
		vscode.window.onDidChangeActiveColorTheme(reset),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('d2')) {
				reset();
			}
		})
	);

	// Markdown files that were already open before this extension activated.
	for (const document of vscode.workspace.textDocuments) {
		if (document.languageId === 'markdown') {
			prewarmer.run(document.getText());
		}
	}

	return {
		extendMarkdownIt(md: MarkdownIt): MarkdownIt {
			markdownItD2(md, { service: d2Service, getDefaults: readDefaultOptions });
			return md;
		},
	};
}

export async function deactivate(): Promise<void> {
	await service?.dispose();
	service = undefined;
}
