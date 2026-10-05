# D2 preview sample

Open the Markdown preview with `Ctrl+Shift+V` (`Cmd+Shift+V` on macOS). Each
` ```d2 ` block below should render as a diagram. Edit the source and the
preview follows along.

## A basic diagram

```d2
direction: right

client -> api: request
api -> db: query
db -> api: rows
api -> client: response
```

## Layout options

Options go in the fence info string, after `d2`. A bare word means `true`, and
`no-` negates it, so `sketch` / `sketch=false` / `no-sketch` all work.

```d2 sketch layout=elk pad=40
title: Write the diagram | md: # Write the diagram

markdown -> parser: text
parser -> ast
ast -> layout
layout -> svg
```

## Containers and styling

```d2
cloud: AWS {
  style.fill: "#f5f5f5"
  style.stroke: "#999"

  lb: Load balancer
  web: Web servers {
    w1
    w2
  }
  db: Database
}

cloud.lb -> cloud.web.w1: :80
cloud.lb -> cloud.web.w2: :80
cloud.web.w1 -> cloud.db: read
cloud.web.w2 -> cloud.db: write
```

## The same diagram twice

Both of these are identical on purpose. D2 puts ids into the SVG it produces, so
without a per-diagram salt the second copy's arrowheads and gradients would
resolve to the first one's. They should look exactly alike.

```d2 sketch
x -> y: one
y -> z: two
z -> x: three
```

```d2 sketch
x -> y: one
y -> z: two
z -> x: three
```

## Custom options

The fence info string covers the common options. Anything else D2 supports goes
into the `d2.compileOptions` and `d2.renderOptions` settings, which are passed
straight to D2's `compile()` and `render()`. For instance, setting

```jsonc
"d2.renderOptions": { "ascii": true }
```

turns the diagram below into a text drawing. The README has the precedence order
and the options the extension keeps for itself.

```d2
client -> api: request
api -> db: query
```

## A syntax error

Errors are reported inline, so one bad diagram does not break the rest of the
preview. This block is missing a target:

```d2
start -> 
```

## Not a D2 block

Other languages are left alone and still get normal syntax highlighting:

```js
const diagram = 'this is not rendered as D2';
```
