# Vendored code

Third-party code committed to this repository rather than installed. Everything here is
**unmodified** upstream output; if a file ever has to be patched, say so in this file and
say why, because a silently edited dependency is the worst of both worlds.

## `d3-force.js`

| | |
|---|---|
| Package | [`d3-force`](https://github.com/d3/d3-force) 3.0.0 |
| Source | `https://esm.sh/d3-force@3.0.0/es2022/d3-force.bundle.mjs` |
| Size | 15.7 KB |
| Licence | ISC — © Mike Bostock. See the upstream `LICENSE` |
| Modified | No |

### Why it is here rather than installed

This project has **no package manager and no bundler**, by decision. d3 itself arrives from
a CDN as a global for the timeline (`index.html`), which is fine for the render layer but
useless to `layout/`: nothing there may touch a browser global, because everything under
`layout/` has to be exercisable in bare Node — that is the project's own test of whether a
module is in the right folder. An installed package would not work either: a bare specifier
like `d3-force` cannot be resolved by a browser without an import map or a bundler.

A single self-contained ES module solves all of it. It imports cleanly in Node's test
runner and in the browser, needs no tooling, and can be read.

### Why the *bundled* build specifically

The obvious URL, `https://cdn.jsdelivr.net/npm/d3-force@3/+esm`, looks right and is not: it
is 8.3 KB and inlines nothing, importing `d3-quadtree`, `d3-dispatch` and `d3-timer` by
absolute jsdelivr path. Vendored, those paths resolve to nothing in Node and to a 404 in
the browser. The alternative — vendoring four files and rewriting the import paths — works,
but leaves patched third-party code in the tree that has to be re-patched on every upgrade.
This build has the three dependencies compiled in and needs no edits.

### Upgrading

Re-download from the same URL with the version bumped, check the file still contains no
`import` statements, and run:

```
node -e "import('./vendor/d3-force.js').then(m => { m.forceSimulation([{x:0,y:0}]).stop().tick(); console.log('ok') })"
```

Then `npm test` — the layout suites exercise it directly.
