const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/**
 * `vscode` is injected by the host at runtime.
 *
 * `@d2lang/d2` is deliberately NOT bundled: its Node build captures
 * `__dirname` and resolves `worker.js`, `wasm_exec.js` and the 41MB
 * `d2.wasm` relative to it, so it has to be loaded from its real
 * location on disk.
 *
 * @type {import('esbuild').BuildOptions}
 */
const shared = {
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	minify: production,
	sourcemap: production ? false : 'inline',
	logLevel: 'info',
	external: ['vscode', '@d2lang/d2'],
};

/** The extension host entry point and the worker thread entry point. */
const builds = [
	{ ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
	{ ...shared, entryPoints: ['src/worker/d2Worker.ts'], outfile: 'dist/d2Worker.js' },
];

async function main() {
	if (isWatch) {
		const contexts = await Promise.all(builds.map(options => esbuild.context(options)));
		await Promise.all(contexts.map(context => context.watch()));
		console.log('[esbuild] watching for changes...');
		return;
	}
	await Promise.all(builds.map(options => esbuild.build(options)));
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
