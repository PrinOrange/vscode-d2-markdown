import type { D2Layout, RenderRequestOptions } from './protocol';

interface OptionSpec {
	readonly key: keyof RenderRequestOptions;
	readonly kind: 'boolean' | 'number' | 'layout';
}

/**
 * Names accepted inside a fence info string. `theme` maps onto `themeID` so that
 * ```` ```d2 theme=5 ```` reads the way the D2 docs talk about themes.
 */
const OPTION_SPECS: Readonly<Record<string, OptionSpec>> = {
	sketch: { key: 'sketch', kind: 'boolean' },
	center: { key: 'center', kind: 'boolean' },
	layout: { key: 'layout', kind: 'layout' },
	theme: { key: 'themeID', kind: 'number' },
	pad: { key: 'pad', kind: 'number' },
	scale: { key: 'scale', kind: 'number' },
};

const LAYOUTS: readonly D2Layout[] = ['dagre', 'elk', 'tala'];

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/** True when a fenced code block's info string asks for D2. */
export function isD2Info(info: string): boolean {
	const language = info.trim().split(/\s+/, 1)[0];
	return language === 'd2';
}

/**
 * Read per-block overrides out of a fence info string:
 *
 * ```d2 sketch layout=elk theme=5 no-center
 * ```
 *
 * A bare word is the same as `word=true`, and the `no-` prefix negates a
 * boolean, so `sketch` / `sketch=false` / `no-sketch` are all expressible.
 * Anything unrecognised is ignored rather than treated as an error.
 */
export function parseD2Info(info: string): Partial<RenderRequestOptions> {
	const overrides: Partial<RenderRequestOptions> = {};
	const tokens = info.trim().split(/\s+/).slice(1);

	for (const token of tokens) {
		const equals = token.indexOf('=');
		let name = (equals === -1 ? token : token.slice(0, equals)).toLowerCase();
		let value = equals === -1 ? 'true' : token.slice(equals + 1);

		let negated = false;
		if (name.startsWith('no-')) {
			negated = true;
			name = name.slice('no-'.length);
		}

		const spec = OPTION_SPECS[name];
		if (!spec) {
			continue;
		}

		if (spec.kind === 'boolean') {
			const parsed = parseBoolean(value);
			if (parsed === undefined) {
				continue;
			}
			assign(overrides, spec.key, negated ? !parsed : parsed);
			continue;
		}

		if (negated) {
			continue;
		}

		if (spec.kind === 'number') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				assign(overrides, spec.key, parsed);
			}
			continue;
		}

		if ((LAYOUTS as readonly string[]).includes(value)) {
			assign(overrides, spec.key, value as D2Layout);
		}
	}

	return overrides;
}

function parseBoolean(value: string): boolean | undefined {
	const normalised = value.toLowerCase();
	if (TRUE_VALUES.has(normalised)) {
		return true;
	}
	if (FALSE_VALUES.has(normalised)) {
		return false;
	}
	return undefined;
}

function assign(
	target: Partial<RenderRequestOptions>,
	key: keyof RenderRequestOptions,
	value: unknown
): void {
	(target as Record<string, unknown>)[key] = value;
}
