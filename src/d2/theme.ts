import * as vscode from 'vscode';

/**
 * True when the active colour theme is a dark variant.
 *
 * `ColorThemeKind.HighContrast` is the dark high-contrast theme;
 * `HighContrastLight` only exists on newer VS Code builds, so it is
 * deliberately not treated as dark.
 */
export function isDarkTheme(): boolean {
	const kind = vscode.window.activeColorTheme.kind;
	return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

/** Pick the light or dark D2 theme id for the theme currently in use. */
export function resolveThemeID(lightTheme: number, darkTheme: number): number {
	return isDarkTheme() ? darkTheme : lightTheme;
}
