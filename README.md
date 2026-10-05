# D2 Diagram Preview

Render [D2](https://d2lang.com) diagrams in VS Code's **built-in Markdown
preview**. Write a ` ```d2 ` code block, open the preview, and the block becomes
an SVG diagram.

````markdown
```d2
direction: right

client -> api: request
api -> db: query
db -> api: rows
api -> client: response
```
````

Diagrams follow the light/dark theme, errors are reported inline instead of
breaking the preview, and rendering happens off the UI thread so typing stays
responsive.

## Requirements

- VS Code 1.85 or newer.
- A desktop (or remote) window — the diagram engine is a WebAssembly module that
  runs in the extension host, so it does not work in the web build of VS Code or
  on vscode.dev.

## Usage

Fence options go after `d2` in the info string:

````markdown
```d2 sketch layout=elk pad=40
a -> b
```
````

| Option | Example | Effect |
| --- | --- | --- |
| `sketch` | `sketch` or `no-sketch` | Hand-drawn look. |
| `center` | `center` or `no-center` | Center the diagram in its viewbox. |
| `layout` | `layout=elk` | `dagre` (default), `elk`, or `tala`. |
| `theme` | `theme=5` | Theme ID, overriding the one chosen from the VS Code theme. |
| `pad` | `pad=40` | Padding around the diagram, in pixels. |
| `scale` | `scale=1.5` | Scale factor. |

A bare word means `true`, and the `no-` prefix negates it, so `sketch`,
`sketch=false` and `no-sketch` all work. Unrecognised options are ignored.

## Custom options

The table above covers the options most diagrams need. Everything else that D2
supports goes through two settings that forward their contents straight to the
engine, using D2's own option names:

```jsonc
{
  "d2.compileOptions": {
    "layout": "elk",
    "forceAppendix": true
  },
  "d2.renderOptions": {
    "scale": 0.8
  }
}
```

`d2.compileOptions` is passed to D2's `compile()` and `d2.renderOptions` to
`render()` — see D2's
[`CompileOptions` and `RenderOptions`](https://github.com/terrastruct/d2/blob/master/d2js/index.d.ts)
for the names and accepted values. Since `CompileOptions` extends
`RenderOptions`, either setting accepts the same keys; they are kept separate
only so an option can be set for one stage without the other.

Options are layered, most specific last:

1. The dedicated `d2.*` settings.
2. `d2.compileOptions`.
3. `d2.renderOptions`.
4. The fence info string, which applies to that one block.

So ```` ```d2 pad=40 ```` beats a `pad` in `d2.renderOptions`, which beats one
in `d2.compileOptions`, which beats `d2.pad`.

Three options are set by the extension and cannot be overridden: `salt` (keeps
the SVG element ids of diagrams in one preview page apart), `noXMLTag` (drops
the XML prolog so the SVG can be inlined) and `darkThemeID` (keeps D2's built-in
`prefers-color-scheme` block from contradicting the editor theme). `salt`,
`noXMLTag` and `darkThemeID` in these settings are ignored. The font options
(`fontRegular`, `fontItalic`, `fontBold`, `fontSemibold`) are also ignored,
since font data cannot be expressed in `settings.json`.

An option D2 does not recognise is passed through and quietly ignored; an
invalid value for one it does recognise is reported as an inline error block
like any other failure.

`"ascii": true` makes D2 return a text drawing instead of an SVG. The block is
still rendered, as a `<pre>` so its alignment survives. `animateInterval` with
several `target` boards is left as the animated SVG D2 produced.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `d2.theme` | `0` | Diagram theme used with a light VS Code theme. |
| `d2.darkTheme` | `200` | Diagram theme used with a dark VS Code theme. |
| `d2.layout` | `dagre` | Default layout engine. |
| `d2.sketch` | `false` | Default sketch mode. |
| `d2.pad` | `100` | Default padding, in pixels. |
| `d2.center` | `false` | Center diagrams by default. |
| `d2.compileOptions` | `{}` | Extra options for D2's `compile()`. |
| `d2.renderOptions` | `{}` | Extra options for D2's `render()`. |
| `d2.renderTimeout` | `15000` | Milliseconds before a single diagram is abandoned. |
| `d2.syncWaitMs` | `350` | Milliseconds the preview may block on an uncached diagram. `0` never blocks. |

Theme IDs come from the [D2 themes](https://d2lang.com/tour/themes) list.
`d2.darkTheme` is used when the VS Code theme is dark, and switching themes
re-renders cached diagrams in the new colours.

## How it works

VS Code's Markdown preview is a webview with a strict Content Security Policy:
it blocks `blob:` workers and `WebAssembly.instantiate`, which is exactly what
the browser build of D2 needs. So the diagram is compiled in the **extension
host** instead, and the resulting SVG is inlined into the preview HTML. The
webview only ever sees markup and CSS.

That raises a second problem: markdown-it's fence renderer must return HTML
*synchronously*, but rendering a diagram is inherently asynchronous. The
extension handles it like this:

1. **Pre-warm.** As you type, every D2 block in the document is rendered in the
   background into an LRU cache, keyed by source, options and salt.
2. **Cache hit.** In the common case the fence renderer finds the finished SVG
   and returns it immediately.
3. **Bounded wait.** On a miss it waits up to `d2.syncWaitMs` for the worker.
   This is only a fallback, and it is capped so a pathological diagram cannot
   freeze the window.
4. **Placeholder + refresh.** If the wait runs out, a placeholder is emitted, the
   abandoned render still lands in the cache, and the preview rebuilds itself
   once it does.

Rendering itself runs in a worker thread holding a single long-lived D2 instance,
so the WebAssembly module is instantiated once per session rather than per
diagram.

Each diagram gets a per-occurrence *salt*, because D2 writes ids into the SVG it
emits (gradients, markers, arrowheads) and a preview page holds many diagrams at
once. Without the salt, the second copy of a diagram would borrow the first
one's definitions.

## Limitations

- `@import` in D2 source is not supported; a diagram must be self-contained.
- The first diagram of a session takes a couple of seconds while the WebAssembly
  module is instantiated. Later diagrams are much faster, and the cost is paid
  in the background.
- D2 ships a ~42 MB WebAssembly binary that has to be installed with the
  extension.

## Development

```sh
npm install
npm run build     # or: npm run watch
npm run check     # type-check
npm run verify    # render a diagram with @d2lang/d2 directly
```

Press `F5` to launch an Extension Development Host, then open
`samples/sample.md` and show its preview.

`npm run package` needs a `repository` field in `package.json`, because the
packager rewrites the README's relative links against it. Add one before
publishing.

## Credits

Diagram rendering is done by the [D2](https://github.com/terrastruct/d2) project
through the official [`@d2lang/d2`](https://www.npmjs.com/package/@d2lang/d2)
package. See `THIRD_PARTY_NOTICES.md`.

## License

[MIT](LICENSE)
