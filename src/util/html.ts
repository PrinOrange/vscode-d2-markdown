/** Escaping helpers for the small amount of HTML this extension emits. */

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/'/g, '&#39;');
}
