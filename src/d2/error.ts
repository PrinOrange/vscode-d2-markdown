/**
 * D2 reports compile errors by throwing a JSON array of `{range, errmsg}`
 * objects. That is precise but unreadable in a preview pane, where it arrives as
 * one long line of escaped JSON.
 *
 * The `errmsg` already carries the location (`index:1:1: ...`), so the messages
 * are what get shown; `range` is a character offset that would need the source
 * to interpret. Anything that does not parse is passed through untouched rather
 * than swallowed.
 */
export function formatD2Error(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('[')) {
		return trimmed;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return trimmed;
	}

	if (!Array.isArray(parsed)) {
		return trimmed;
	}

	const messages = parsed
		.map(entry => (isErrorEntry(entry) ? entry.errmsg.trim() : ''))
		.filter(message => message.length > 0);

	return messages.length > 0 ? messages.join('\n\n') : trimmed;
}

function isErrorEntry(value: unknown): value is { errmsg: string } {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { errmsg?: unknown }).errmsg === 'string'
	);
}
