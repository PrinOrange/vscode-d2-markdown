/**
 * The markdown-it plugin that turns ` ```d2 ` fences into inline SVG.
 *
 * markdown-it's fence renderer has to return a string synchronously, so this
 * cannot await a render. It relies on the service's cache being warm (the
 * pre-warmer fills it as the user types) and otherwise emits a placeholder plus
 * a short bounded wait; whichever way that goes, the diagram appears on the next
 * preview refresh.
 *
 * The only types taken from markdown-it are the few structural pieces used
 * here. Depending on `@types/markdown-it` would pin a version that has to keep
 * agreeing with the copy VS Code itself bundles, for no benefit.
 */
import type { RenderRequestOptions } from './d2/protocol';
import type { D2Service } from './d2/service';
import { normalizeD2Source, SaltTracker } from './d2/blocks';
import { formatD2Error } from './d2/error';
import { isD2Info, parseD2Info } from './d2/options';
import { escapeHtml } from './util/html';

//#region minimal markdown-it surface

export interface MarkdownToken {
	type: string;
	info: string;
	content: string;
}

export type MarkdownRendererRule = (
	tokens: MarkdownToken[],
	index: number,
	options: unknown,
	env: unknown,
	self: MarkdownRenderer
) => string;

export interface MarkdownRenderer {
	rules: Record<string, MarkdownRendererRule | undefined>;
}

export interface MarkdownIt {
	renderer: MarkdownRenderer;
}

//#endregion

export interface D2PluginContext {
	readonly service: D2Service;
	/** Read fresh each render so a settings change takes effect immediately. */
	getDefaults(): RenderRequestOptions;
}

/** Tracks diagram occurrences within one render pass, so salts stay stable. */
const trackers = new WeakMap<object, SaltTracker>();
const sharedTracker = new SaltTracker();

export function markdownItD2(md: MarkdownIt, context: D2PluginContext): void {
	const fallback = md.renderer.rules.fence;

	md.renderer.rules.fence = (tokens, index, options, env, self) => {
		const token = tokens[index];
		if (!token || !isD2Info(token.info)) {
			return fallback
				? fallback(tokens, index, options, env, self)
				: plainFence(token);
		}
		return renderDiagram(token, env, context);
	};
}

function renderDiagram(
	token: MarkdownToken,
	env: unknown,
	context: D2PluginContext
): string {
	const source = normalizeD2Source(token.content);
	const outcome = context.service.renderSync(source, {
		...context.getDefaults(),
		// Sent as their own layer so they are applied after the global options.
		block: parseD2Info(token.info),
		salt: trackerFor(env).next(source),
	});

	switch (outcome.kind) {
		case 'output':
			return isSvg(outcome.output)
				? `<div class="d2-diagram">${outcome.output}</div>`
				: asciiBlock(outcome.output);
		case 'error':
			return errorBlock(formatD2Error(outcome.error), source);
		default:
			return '<div class="d2-diagram d2-diagram--pending" aria-busy="true">'
				+ '<span class="d2-status">Rendering D2 diagram&hellip;</span></div>';
	}
}

/**
 * Distinguish an SVG drawing from an ASCII one (`ascii: true`).
 *
 * Deliberately not anchored to the start: an animated SVG, produced with
 * `animateInterval`, carries an XML prolog that the worker strips but that may
 * come back if D2 changes, and testing for the element anywhere is what
 * actually matters.
 */
function isSvg(output: string): boolean {
	return /<svg[\s>]/i.test(output);
}

/** ASCII drawings are whitespace-sensitive, so they go in a `<pre>` verbatim. */
function asciiBlock(art: string): string {
	return `<pre class="d2-ascii">${escapeHtml(art)}</pre>`;
}

function errorBlock(message: string, source: string): string {
	return '<div class="d2-error" role="alert">'
		+ '<p class="d2-error-title">D2 diagram could not be rendered</p>'
		+ `<pre class="d2-error-message">${escapeHtml(message.trim())}</pre>`
		+ '<details><summary>Diagram source</summary>'
		+ `<pre class="d2-error-source"><code>${escapeHtml(source)}</code></pre>`
		+ '</details></div>';
}

/** Used only if the host markdown-it has no default fence rule to defer to. */
function plainFence(token: MarkdownToken | undefined): string {
	const info = token?.info.trim() ?? '';
	const language = info.split(/\s+/, 1)[0];
	const className = language ? ` class="language-${escapeHtml(language)}"` : '';
	return `<pre><code${className}>${escapeHtml(token?.content ?? '')}</code></pre>\n`;
}

function trackerFor(env: unknown): SaltTracker {
	if (typeof env !== 'object' || env === null) {
		// Not a shape we recognise; a shared tracker still keeps ids apart, at
		// the cost of salts drifting between renders.
		return sharedTracker;
	}
	let tracker = trackers.get(env);
	if (!tracker) {
		tracker = new SaltTracker();
		trackers.set(env, tracker);
	}
	return tracker;
}
