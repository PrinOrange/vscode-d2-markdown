import * as vscode from 'vscode';
import type { CustomOptions, D2Layout, RenderRequestOptions } from './protocol';
import { resolveThemeID } from './theme';

const SECTION = 'd2';

/**
 * Every option name in D2's `RenderOptions` and `CompileOptions`, so a typo in
 * the free-form settings can be pointed out instead of silently doing nothing.
 * Kept in step with `@d2lang/d2`'s own type definitions.
 */
const KNOWN_OPTIONS = new Set([
	// RenderOptions
	'sketch',
	'themeID',
	'darkThemeID',
	'center',
	'pad',
	'scale',
	'forceAppendix',
	'target',
	'animateInterval',
	'salt',
	'noXMLTag',
	'ascii',
	'asciiMode',
	// CompileOptions
	'layout',
	'fontRegular',
	'fontItalic',
	'fontBold',
	'fontSemibold',
]);

/**
 * Options the extension sets itself because a diagram rendered with the user's
 * value would be wrong rather than merely different. Each is reported if the
 * user sets it, so the override is visible instead of mysterious.
 */
const OWNED_OPTIONS = new Set(['salt', 'noXMLTag', 'darkThemeID']);

/**
 * Font overrides take binary data, which cannot be expressed in settings.json.
 * They are dropped rather than passed through as strings that D2 would choke on.
 */
const UNSUPPORTED_OPTIONS = new Set(['fontRegular', 'fontItalic', 'fontBold', 'fontSemibold']);

/** Keys already reported, so a bad setting is not logged on every render. */
const reported = new Set<string>();

/**
 * The options every diagram starts from, before per-block overrides.
 *
 * Precedence, most specific last: the dedicated settings, then
 * `d2.compileOptions`, then `d2.renderOptions`, then the fence info string.
 *
 * The theme is resolved to a single concrete id here rather than relying on
 * `prefers-color-scheme` inside the SVG: a VS Code webview reports the *OS*
 * scheme through that media query, not `workbench.colorTheme`, so the media
 * query route would disagree with the editor in exactly the case that matters.
 */
export function readDefaultOptions(): RenderRequestOptions {
	const config = vscode.workspace.getConfiguration(SECTION);
	return {
		themeID: resolveThemeID(
			config.get<number>('theme', 0),
			config.get<number>('darkTheme', 200)
		),
		layout: config.get<D2Layout>('layout', 'dagre'),
		sketch: config.get<boolean>('sketch', false),
		pad: config.get<number>('pad', 100),
		center: config.get<boolean>('center', false),
		compile: readCustomOptions(config, 'compileOptions'),
		render: readCustomOptions(config, 'renderOptions'),
	};
}

/**
 * How long the extension host may block waiting for a diagram. Diagrams that
 * are already warm finish well inside this; the value exists so that a
 * pathological diagram degrades to a placeholder instead of a frozen window.
 * `0` disables blocking altogether.
 */
export function readSyncBudgetMs(): number {
	const value = vscode.workspace.getConfiguration(SECTION).get<number>('syncWaitMs', 350);
	return Number.isFinite(value) ? Math.max(0, value) : 350;
}

/** Upper bound on a single render before the worker is treated as stuck. */
export function readRenderTimeoutMs(): number {
	// The fallback matches the setting's declared default in package.json.
	const value = vscode.workspace.getConfiguration(SECTION).get<number>('renderTimeout', 15000);
	return Number.isFinite(value) && value > 0 ? value : 15000;
}

/**
 * Read one of the free-form option objects, dropping what cannot or should not
 * be forwarded and reporting anything suspicious once per session.
 */
function readCustomOptions(
	config: vscode.WorkspaceConfiguration,
	name: 'compileOptions' | 'renderOptions'
): CustomOptions {
	const raw = config.get<unknown>(name, {});
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		reportOnce(`${name}:not-an-object`, `[vscode-d2] d2.${name} should be an object; ignoring it.`);
		return {};
	}

	const options: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === undefined) {
			continue;
		}
		if (UNSUPPORTED_OPTIONS.has(key)) {
			reportOnce(
				`${name}:${key}`,
				`[vscode-d2] d2.${name}.${key} is not supported: font data cannot be ` +
					'expressed in settings.json. The built-in font is used instead.'
			);
			continue;
		}
		if (OWNED_OPTIONS.has(key)) {
			reportOnce(
				`${name}:${key}`,
				`[vscode-d2] d2.${name}.${key} is ignored: the extension sets it itself, ` +
					'because diagrams sharing a preview document, or switching with the ' +
					'theme, depend on its value.'
			);
			continue;
		}
		if (!KNOWN_OPTIONS.has(key)) {
			reportOnce(
				`${name}:${key}`,
				`[vscode-d2] d2.${name}.${key} is not a known D2 option. It is forwarded ` +
					'anyway, so check the spelling if it has no effect.'
			);
		}
		options[key] = value;
	}
	return options;
}

function reportOnce(id: string, message: string): void {
	if (reported.has(id)) {
		return;
	}
	reported.add(id);
	console.warn(message);
}
