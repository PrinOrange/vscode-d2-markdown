/**
 * Helpers for asserting things about the SVG that D2 emits, shared by the
 * verification scripts.
 */

/** Slice out the body of the first block that follows `marker`. */
function blockAfter(svg, marker) {
	const start = svg.indexOf(marker);
	if (start === -1) {
		return null;
	}
	const open = svg.indexOf('{', start);
	if (open === -1) {
		return null;
	}
	let depth = 1;
	let i = open + 1;
	while (i < svg.length && depth > 0) {
		if (svg[i] === '{') {
			depth++;
		} else if (svg[i] === '}') {
			depth--;
		}
		i++;
	}
	return { body: svg.slice(open + 1, i - 1), start, end: i };
}

const squeeze = value => value.replace(/\s+/g, '');

/**
 * True when D2's `prefers-color-scheme` block declares nothing that is not
 * already declared outside it.
 *
 * D2 always emits such a block holding the *dark* theme, so if it disagrees with
 * the rest of the SVG the diagram's colours depend on the viewer's OS setting
 * rather than on the theme the extension chose. The extension points the dark
 * theme at the resolved theme precisely so this returns true.
 */
export function mediaIsInert(svg) {
	const found = blockAfter(svg, '@media');
	if (!found) {
		return true;
	}
	const outside = squeeze(svg.slice(0, found.start) + svg.slice(found.end));
	const declarations = [...found.body.matchAll(/[^{}]+\{[^{}]*\}/g)].map(match =>
		squeeze(match[0])
	);
	return declarations.every(declaration => outside.includes(declaration));
}

/** True when the SVG has a `prefers-color-scheme` block at all. */
export function hasMediaQuery(svg) {
	return svg.includes('prefers-color-scheme');
}
