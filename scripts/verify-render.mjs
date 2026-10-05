/**
 * Smoke test for the `@d2lang/d2` Node build.
 *
 * This runs the same code path the extension host uses (compile -> render) so a
 * broken dependency is caught before it turns into an empty preview pane.
 *
 *   node scripts/verify-render.mjs
 */
import { createRequire } from 'node:module';
import { hasMediaQuery, mediaIsInert } from './lib/svg.mjs';

const require = createRequire(import.meta.url);

const SOURCE = `direction: right
client -> api: request
api -> db: query
db -> api: rows
api -> client: response`;

function assert(condition, message) {
	if (!condition) {
		throw new Error(`FAIL: ${message}`);
	}
}

async function main() {
	const { D2 } = require('@d2lang/d2');
	const d2 = new D2();

	try {
		console.log('compiling + rendering a sample diagram...');
		const started = Date.now();
		const compiled = await d2.compile(SOURCE, { layout: 'dagre' });
		const svg = await d2.render(compiled.diagram, {
			...compiled.renderOptions,
			noXMLTag: true,
		});
		console.log(`render took ${Date.now() - started}ms`);

		assert(typeof svg === 'string' && svg.length > 0, 'render returned an empty string');
		assert(svg.includes('<svg'), 'output does not look like SVG');
		assert(!svg.startsWith('<?xml'), 'noXMLTag did not strip the XML prolog');
		console.log(`svg length: ${svg.length} chars`);

		// Multiple diagrams in one preview document must not share element ids,
		// otherwise gradients/markers/arrowheads resolve to the wrong diagram.
		const a = await d2.render(compiled.diagram, { ...compiled.renderOptions, noXMLTag: true, salt: 'a' });
		const b = await d2.render(compiled.diagram, { ...compiled.renderOptions, noXMLTag: true, salt: 'b' });
		assert(a !== b, 'salt did not change the output, so ids would collide');

		// Syntax errors must surface as a rejected promise, which the extension
		// turns into an inline error block rather than a broken preview.
		let failed = false;
		try {
			await d2.compile('a -> ');
		} catch {
			failed = true;
		}
		assert(failed, 'a malformed diagram did not produce an error');

		// D2 always emits a `prefers-color-scheme: dark` block holding
		// `darkThemeID`, which would override the chosen colours based on the
		// viewer's media query rather than on the VS Code theme. The worker
		// points `darkThemeID` at the resolved theme to neuter it; this is the
		// control proving such a block really does carry a second palette.
		const renderThemed = async (themeID, darkThemeID) => {
			const c = await d2.compile(SOURCE, { themeID, darkThemeID });
			return d2.render(c.diagram, {
				...c.renderOptions,
				themeID,
				darkThemeID,
				noXMLTag: true,
			});
		};

		const light5dark200 = await renderThemed(5, 200);
		const light5dark5 = await renderThemed(5, 5);

		assert(hasMediaQuery(light5dark200), 'expected a prefers-color-scheme block');
		assert(
			!mediaIsInert(light5dark200),
			'a dark theme should put a second palette in the media block'
		);
		assert(
			light5dark200 !== light5dark5,
			'darkThemeID should change the rendered colours'
		);
		assert(
			mediaIsInert(light5dark5),
			'matching darkThemeID to themeID should make the media block inert'
		);
		console.log('media block carries darkThemeID, and is inert when they match');

		console.log('OK: d2 compiles, renders SVG, honours salt, and reports errors.');
	} finally {
		await d2.dispose();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
