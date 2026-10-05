/**
 * 32-bit FNV-1a. Only used to build short, stable salts for diagram ids, so
 * collisions are cosmetic rather than correctness problems.
 */
export function hashString(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function shortHash(value: string): string {
	return hashString(value).toString(36);
}
