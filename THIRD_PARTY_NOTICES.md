# Third-party notices

This extension is MIT licensed, but it distributes third-party software that is
not, and that software is shipped inside the package rather than fetched at
install time.

## @d2lang/d2

- **License:** Mozilla Public License 2.0 (MPL-2.0)
- **Source:** <https://github.com/terrastruct/d2/tree/master/d2js>
- **Package:** <https://www.npmjs.com/package/@d2lang/d2>

The full license text and the notices for the software bundled inside it ship
with the package, unchanged, at:

```
node_modules/@d2lang/d2/LICENSE.txt
node_modules/@d2lang/d2/THIRD_PARTY_NOTICES.txt
```

The package's `dist/node-cjs/` directory — including `d2.wasm`, which contains
the compiled D2 compiler and its Go dependencies — is redistributed verbatim.
The corresponding source is the upstream repository linked above and the npm
package archive of the exact version in `package.json`.

Nothing in `@d2lang/d2` has been modified.
