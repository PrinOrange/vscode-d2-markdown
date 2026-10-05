/**
 * Finding and fingerprinting D2 code blocks in a markdown document.
 *
 * The markdown-it plugin and the pre-warmer both go through here, because they
 * have to derive *identical* sources and salts: a pre-warmed diagram only saves
 * a render if its cache key matches the one the fence renderer computes later.
 */
import { shortHash } from '../util/hash';
import { isD2Info } from './options';

/** A fenced code block found in a document, with its info string intact. */
export interface MarkdownFence {
	readonly info: string;
	/** Block content, newline-normalised, with a trailing newline. */
	readonly content: string;
}

/**
 * Put a diagram into the form used for hashing and rendering.
 *
 * Line endings are normalised so a file saved on Windows and the same file
 * saved on Unix agree, and trailing whitespace is dropped so that adding a blank
 * line at the end of a diagram does not invalidate its cache entry.
 */
export function normalizeD2Source(raw: string): string {
	return raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/**
 * Hands out a salt for each diagram occurrence in one pass over a document.
 *
 * D2 puts element ids into the SVG it emits (gradients, markers, arrowheads),
 * and a preview page holds every diagram in one document. Two diagrams sharing
 * an id resolve to whichever came first, so the ids have to be made unique -
 * hence a salt per occurrence. The salt is derived from the source plus how many
 * earlier diagrams had that exact source, which keeps it stable across renders.
 */
export class SaltTracker {
	readonly #counts = new Map<string, number>();

	next(source: string): string {
		const seen = this.#counts.get(source) ?? 0;
		this.#counts.set(source, seen + 1);
		return `${shortHash(source)}-${seen}`;
	}
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Pull every fenced code block out of a markdown document, in document order.
 *
 * This is a focused scanner rather than a full markdown parser: it only has to
 * find fences, and the markdown parser remains the authority on what the blocks
 * actually contain. Fences indented into lists or blockquotes are not handled,
 * which costs a pre-warm but never changes what is rendered.
 */
export function extractFences(markdown: string): MarkdownFence[] {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	const fences: MarkdownFence[] = [];

	let open: { marker: string; char: string; info: string; body: string[] } | undefined;

	for (const line of lines) {
		if (open) {
			const closes = new RegExp(`^ {0,3}\\${open.char}{${open.marker.length},}\\s*$`);
			if (closes.test(line)) {
				fences.push({ info: open.info, content: `${open.body.join('\n')}\n` });
				open = undefined;
			} else {
				open.body.push(line);
			}
			continue;
		}

		const match = FENCE_OPEN.exec(line);
		if (!match) {
			continue;
		}
		const marker = match[1];
		const info = match[2].trim();
		// An info string containing a backtick disqualifies the line as a fence.
		if (info.includes('`')) {
			continue;
		}
		open = { marker, char: marker[0], info, body: [] };
	}

	// An unterminated fence runs to the end of the document, same as in
	// CommonMark.
	if (open) {
		fences.push({ info: open.info, content: `${open.body.join('\n')}\n` });
	}

	return fences;
}

/** The D2 blocks of a document, in the order they will be rendered. */
export function extractD2Blocks(markdown: string): MarkdownFence[] {
	return extractFences(markdown).filter(fence => isD2Info(fence.info));
}
