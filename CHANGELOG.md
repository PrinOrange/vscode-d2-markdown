# Changelog

## 0.1.0

Initial release.

- Render ` ```d2 ` code blocks as diagrams in VS Code's built-in Markdown
  preview.
- Follow the light/dark theme, and re-render diagrams when it changes.
- Report D2 syntax errors inline, with the offending source.
- Per-block options in the fence info string: `sketch`, `center`, `layout`,
  `theme`, `pad`, `scale`, plus the `no-` prefix.
- Settings for default theme, layout, padding, centering, render timeout and
  the synchronous wait budget.
- `d2.compileOptions` and `d2.renderOptions` forward any other D2 option
  through to `compile()` and `render()`, layered under the fence info string.
  Options the extension owns (`salt`, `noXMLTag`, `darkThemeID`) are guarded.
- Background pre-rendering with an LRU cache, so previews are usually cache
  hits and slow diagrams never block editing.
