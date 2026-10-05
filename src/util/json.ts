/**
 * Serialise a value with object keys in sorted order.
 *
 * Used for cache keys. `JSON.stringify` would make two settings objects that
 * differ only in the order their keys were written look like different options,
 * which would produce a cache miss on every render for no reason.
 */
export function stableStringify(value: unknown): string {
	if (value === undefined) {
		return 'undefined';
	}
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null';
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
		.join(',')}}`;
}
