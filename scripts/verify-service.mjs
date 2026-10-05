/**
 * End-to-end test of the render pipeline.
 *
 * `D2Service` and the markdown-it plugin deliberately avoid importing `vscode`,
 * so the parts that actually carry risk - the worker thread, the synchronous
 * bridge, the cache, and the placeholder/refresh handoff - can be driven from
 * plain Node against the same bundles the extension ships.
 *
 *   node scripts/verify-service.mjs
 *
 * The harness is bundled into `dist/` because the service starts the worker
 * relative to its own directory.
 */
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(projectRoot, 'dist', 'verify-service.cjs');

const HARNESS = `
import { D2Service } from './d2/service';
import { extractD2Blocks, normalizeD2Source, SaltTracker } from './d2/blocks';
import { formatD2Error } from './d2/error';
import { parseD2Info } from './d2/options';
import { hasMediaQuery, mediaIsInert } from '../scripts/lib/svg.mjs';
import { markdownItD2 } from './markdownItPlugin';
import type { RenderRequestOptions } from './d2/protocol';

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error('FAIL: ' + message);
	}
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SIMPLE = 'client -> api: request\\napi -> db: query';
const BROKEN = 'start -> ';

function bigDiagram(nodes: number): string {
	const lines = ['direction: right'];
	for (let i = 0; i < nodes; i++) {
		lines.push('n' + i + ' -> n' + (i + 1));
	}
	return lines.join('\\n');
}

export async function main() {
	const report: Record<string, unknown> = {};
	let budget = 10000;
	let refreshes = 0;

	const service = new D2Service({
		getSyncBudgetMs: () => budget,
		getRenderTimeoutMs: () => 120000,
		onRendered: () => {
			refreshes++;
		},
	});

	const hit = async (source: string, options: RenderRequestOptions, timeout = 120000) => {
		const deadline = Date.now() + timeout;
		for (;;) {
			const outcome = service.renderSync(source, options);
			if (outcome.kind !== 'pending') {
				return outcome;
			}
			if (Date.now() > deadline) {
				throw new Error('timed out waiting for ' + JSON.stringify(source.slice(0, 20)));
			}
			await delay(20);
		}
	};

	// 1. A cold render goes over the synchronous bridge: the worker has to
	//    instantiate wasm, so this also covers the "first render is slow" case.
	await service.start();
	const cold = Date.now();
	const first = service.renderSync(SIMPLE, { salt: 's1' });
	assert(first.kind === 'output', 'cold render should produce output, got ' + first.kind);
	assert(first.output.includes('<svg'), 'output does not look like SVG');
	report.coldRenderMs = Date.now() - cold;
	report.svgBytes = first.output.length;

	// 2. The same diagram at a zero budget must still be served, from the cache.
	budget = 0;
	const cached = service.renderSync(SIMPLE, { salt: 's1' });
	assert(cached.kind === 'output', 'cache should serve at a zero budget, got ' + cached.kind);
	report.cacheHit = true;

	// 3. A different diagram at a zero budget has nothing to serve, so it must
	//    degrade to a placeholder and finish in the background.
	const uncached = service.renderSync(bigDiagram(50), { salt: 's2' });
	assert(uncached.kind === 'pending', 'an uncached diagram should be pending, got ' + uncached.kind);
	budget = 10000;
	report.placeholderThenAsync = (await hit(bigDiagram(50), { salt: 's2' })).kind;

	// 4. Compile errors come back as a value the plugin can render, not a throw,
	//    and they are reformatted out of D2's JSON envelope before display.
	const broken = await hit(BROKEN, { salt: 's3' });
	assert(broken.kind === 'error', 'a malformed diagram should be an error, got ' + broken.kind);
	assert(broken.error.trim().startsWith('['), 'expected D2 error JSON, got: ' + broken.error);
	const formatted = formatD2Error(broken.error);
	assert(!formatted.includes('[{"'), 'the JSON envelope should be stripped');
	assert(
		formatted.includes('connection missing destination'),
		'the underlying message should survive formatting: ' + formatted
	);
	report.errorMessage = formatted;

	// 5. The abandoned path. A one millisecond budget cannot possibly cover a
	//    real render, so the host gives up - and the result must still reach the
	//    cache, with a refresh requested to replace the placeholder.
	const big = bigDiagram(200);
	const refreshesBefore = refreshes;
	budget = 1;
	const abandoned = service.renderSync(big, { salt: 's4' });
	assert(abandoned.kind === 'pending', 'a 1ms budget should time out, got ' + abandoned.kind);
	budget = 10000;
	await hit(big, { salt: 's4' });
	assert(refreshes > refreshesBefore, 'an abandoned render should request a refresh');
	report.abandonedThenCached = 'ok';

	// 6. Theme changes invalidate everything that was cached.
	service.invalidate();
	budget = 0;
	const afterInvalidate = service.renderSync(SIMPLE, { salt: 's1' });
	assert(afterInvalidate.kind === 'pending', 'invalidate should empty the cache');
	budget = 10000;
	await hit(SIMPLE, { salt: 's1' });
	report.invalidate = 'ok';

	// 7. Whatever the theme, the emitted SVG must not carry a second palette in
	//    its prefers-color-scheme block - that block answers to the viewer's
	//    media query, not to the VS Code theme, so it would win on a light
	//    editor running under a dark OS setting.
	const themed = await hit(SIMPLE, { salt: 's1', themeID: 200 });
	assert(themed.kind === 'output', 'a themed render should produce output');
	assert(hasMediaQuery(themed.output), 'expected d2 to emit a media query');
	assert(mediaIsInert(themed.output), 'the dark media block should not override the theme');
	report.themeNeutralised = 'ok';

	// 8. Custom D2 options are forwarded, and the layers are applied in order:
	//    the options the extension models are the base, then d2.compileOptions,
	//    then d2.renderOptions, then a per-block override. pad is used as the
	//    probe because it changes the viewBox, so the effects are visible.
	const padOf = svg => {
		const match = /viewBox="([^"]+)"/.exec(svg);
		return match ? match[1] : '?';
	};
	const padBase = await hit(SIMPLE, { salt: 'p', pad: 200 });
	const padObject = await hit(SIMPLE, { salt: 'p', pad: 200, render: { pad: 5 } });
	const padBlock = await hit(
		SIMPLE,
		{ salt: 'p', pad: 200, render: { pad: 5 }, block: { pad: 200 } }
	);
	assert(padBase.kind === 'output' && padObject.kind === 'output' && padBlock.kind === 'output',
		'custom-option renders should produce output');
	assert(padOf(padObject.output) !== padOf(padBase.output),
		'd2.renderOptions should override the modelled option, got ' + padOf(padObject.output));
	assert(padOf(padBlock.output) === padOf(padBase.output),
		'a per-block option should override d2.renderOptions, got ' + padOf(padBlock.output));
	report.optionLayers = { base: padOf(padBase.output), object: padOf(padObject.output) };

	// 9. Two option objects that differ only in key order are the same options,
	//    so they must share a cache entry rather than re-render.
	const orderA = service.renderSync(SIMPLE, { salt: 'order', compile: { pad: 30, sketch: false } });
	assert(orderA.kind === 'output', 'expected output for the ordered options');
	budget = 0;
	const orderB = service.renderSync(SIMPLE, { salt: 'order', compile: { sketch: false, pad: 30 } });
	assert(
		orderB.kind === 'output',
		'reordered option keys should hit the same cache entry, got ' + orderB.kind
	);
	budget = 10000;
	report.cacheKeyOrderStable = 'ok';

	// 10. Options the extension owns cannot be overridden by a pass-through, or
	//     diagrams in one document would share ids and the inlined markup would
	//     carry an XML prolog.
	const guarded = await hit(SIMPLE, {
		salt: 'guard',
		render: { salt: 'hijacked', noXMLTag: false },
	});
	assert(guarded.kind === 'output', 'expected output from the guarded render');
	assert(!guarded.output.trimStart().startsWith('<?xml'), 'noXMLTag must stay forced on');
	assert(!guarded.output.includes('hijacked'), 'the per-diagram salt must win');
	report.ownedOptionsGuarded = 'ok';

	// 11. ascii: true makes D2 return a text drawing rather than an SVG, which
	//     the fence rule has to recognise and wrap in a <pre> instead.
	const ascii = await hit(SIMPLE, { salt: 'ascii', render: { ascii: true } });
	assert(ascii.kind === 'output', 'expected output from an ascii render');
	assert(!/<svg[\\s>]/i.test(ascii.output), 'ascii output should not contain an svg element');
	assert(ascii.output.includes('client'), 'ascii output should contain the diagram text');
	const asciiFirstLine = ascii.output.split(String.fromCharCode(10))[0];
	report.asciiOutput = JSON.stringify(asciiFirstLine);

	// 12. An animated SVG (animateInterval) ignores noXMLTag and comes back with
	//     an XML prolog, which would sit in the HTML as a bogus comment. It has
	//     to be stripped - and the output must still read as an SVG, or the fence
	//     rule would mistake it for ASCII.
	const animated = await hit(SIMPLE, { salt: 'anim', render: { animateInterval: 500 } });
	assert(animated.kind === 'output', 'expected output from an animated render');
	assert(!animated.output.trimStart().startsWith('<?xml'), 'the XML prolog should be stripped');
	assert(/<svg[\\s>]/i.test(animated.output), 'an animated render is still an SVG');
	report.xmlPrologStripped = 'ok';

	// 13. A shut-down service reports the problem rather than hanging.
	await service.dispose();
	assert(
		service.renderSync(SIMPLE, { salt: 's1' }).kind === 'error',
		'a disposed service should report an error'
	);
	report.dispose = 'ok';

	// 14. Block extraction and salts: the plugin and the pre-warmer have to agree
	//     on both, or pre-warming never produces a hit.
	const markdown = [
		'# Title',
		'',
		'\`\`\`d2 sketch',
		'x -> y',
		'\`\`\`',
		'',
		'\`\`\`js',
		'not d2',
		'\`\`\`',
		'',
		'\`\`\`d2 sketch',
		'x -> y',
		'\`\`\`',
	].join('\\n');

	const blocks = extractD2Blocks(markdown);
	assert(blocks.length === 2, 'expected 2 d2 blocks, found ' + blocks.length);

	const salts = (text: string) => {
		const tracker = new SaltTracker();
		return extractD2Blocks(text).map(f =>
			tracker.next(normalizeD2Source(f.content))
		);
	};
	const firstPass = salts(markdown);
	const secondPass = salts(markdown);
	assert(
		JSON.stringify(firstPass) === JSON.stringify(secondPass),
		'salts should be stable across passes'
	);
	assert(firstPass[0] !== firstPass[1], 'identical diagrams need distinct salts');

	const blockOptions = parseD2Info(blocks[0].info);
	assert(blockOptions.sketch === true, 'the fence info string should set sketch');
	report.salts = firstPass;

	// 15. The fence renderer, with a stub service standing in for the worker.
	//     The stub reports back what it was handed, so the test can see how the
	//     plugin layered the options rather than only what it emitted.
	let lastRenderOptions: Record<string, unknown> | undefined;
	let stubOutcome: { kind: string; output?: string; error?: string } | undefined;
	const md = { renderer: { rules: { fence: () => 'plain' } } };
	markdownItD2(md as never, {
		service: {
			renderSync: (source: string, renderOptions: RenderRequestOptions) => {
				lastRenderOptions = renderOptions as unknown as Record<string, unknown>;
				if (!stubOutcome) {
					return {
						kind: 'output' as const,
						output: '<svg data-salt="' + renderOptions.salt + '"></svg>',
					};
				}
				return stubOutcome.kind === 'error'
					? { kind: 'error' as const, error: 'stubbed: ' + source }
					: { kind: 'output' as const, output: stubOutcome.output ?? '' };
			},
		} as never,
		getDefaults: () => ({ sketch: false, layout: 'dagre' }),
	});
	const render = md.renderer.rules.fence!;
	const runFence = (info: string, outcome?: typeof stubOutcome) => {
		stubOutcome = outcome;
		return render([{ type: 'fence', info, content: 'a -> b\\n' }], 0, {}, {}, md.renderer as never);
	};

	const svgHtml = runFence('d2');
	assert(svgHtml.includes('<div class="d2-diagram">'), 'svg output should be wrapped');
	assert(svgHtml.includes('data-salt="'), 'the diagram should carry a salt');

	// Fence overrides travel in their own layer rather than being merged into
	// the defaults, so the worker can apply them after the global options.
	runFence('d2 sketch layout=elk no-center');
	const block = (lastRenderOptions?.block ?? {}) as Record<string, unknown>;
	assert(block.sketch === true, 'the fence info string should set the block layer');
	assert(block.layout === 'elk', 'fence layout should reach the block layer');
	assert(block.center === false, 'the no- prefix should negate');
	assert(lastRenderOptions?.sketch === false,
		'the modelled default should be left for the worker to layer under');

	// A compile error becomes an inline block, with the message escaped.
	const errorHtml = runFence('d2', { kind: 'error' });
	assert(errorHtml.includes('d2-error'), 'an error should render an error block');
	assert(errorHtml.includes('stubbed: a -&gt; b'), 'the error should be escaped');

	// An ascii render returns text, not SVG, so the fence rule has to wrap it in
	// a pre - for the alignment - and escape it so it cannot inject markup.
	const asciiHtml = runFence('d2', { kind: 'output', output: 'hello <world>\\n  |' });
	assert(
		asciiHtml.startsWith('<pre class="d2-ascii">'),
		'ascii output should go in a pre, not a diagram div: ' + asciiHtml.slice(0, 40)
	);
	assert(asciiHtml.includes('hello &lt;world&gt;'), 'ascii output should be escaped');
	assert(asciiHtml.includes('\\n  |'), 'ascii alignment should be preserved');

	const otherHtml = runFence('js');
	assert(otherHtml === 'plain', 'non-D2 fences should defer to the default rule');
	report.fenceRule = 'ok';

	// 16. Two occurrences of one diagram in a single render pass must not share
	//     a salt, or their SVG element ids would collide.
	const pass: unknown = {};
	const tokens = [
		{ type: 'fence', info: 'd2', content: 'a -> b\\n' },
		{ type: 'fence', info: 'd2', content: 'a -> b\\n' },
	];
	const seen: { source: string; salt: string | undefined }[] = [];
	markdownItD2(md as never, {
		service: {
			renderSync: (source: string, renderOptions: RenderRequestOptions) => {
				seen.push({ source, salt: renderOptions.salt });
				return { kind: 'output' as const, output: '<svg></svg>' };
			},
		} as never,
		getDefaults: () => ({ layout: 'dagre' }),
	});
	const renderAgain = md.renderer.rules.fence!;
	renderAgain(tokens, 0, {}, pass, md.renderer as never);
	renderAgain(tokens, 1, {}, pass, md.renderer as never);

	assert(seen.length === 2, 'expected two renders, got ' + seen.length);
	assert(seen[0].source === seen[1].source, 'both blocks should be the same source');
	assert(
		seen[0].salt !== undefined && seen[0].salt !== seen[1].salt,
		'identical diagrams in one pass need distinct salts'
	);
	report.occurrenceSalts = seen.map(entry => entry.salt);

	return report;
}
`;

async function main() {
	console.log('bundling the harness...');
	await build({
		stdin: {
			contents: HARNESS,
			resolveDir: path.join(projectRoot, 'src'),
			loader: 'ts',
			sourcefile: 'verify-service-harness.ts',
		},
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		external: ['@d2lang/d2'],
		outfile,
		logLevel: 'warning',
	});

	const mod = await import(pathToFileURL(outfile).href);
	const report = await mod.main();

	console.log(JSON.stringify(report, null, 2));
	console.log('OK: service, cache, async fallback, and fence rule all behave.');
}

main()
	.catch(error => {
		console.error(error);
		// The worker and its message ports would otherwise keep the loop alive
		// after a failed assertion, and the run would appear to hang.
		process.exit(1);
	})
	.finally(() => {
		fs.rmSync(outfile, { force: true });
	});
