# tinyrouter

tinyrouter is a tiny framework-agnostic client-side router in a single file vanilla JavaScript file.

## Installation

tinyrouter is meant to be [vendored](https://htmx.org/essays/vendoring/); simply copy and paste `tinyrouter.js` into your project!

## Quick start

Routes are a tree built from three functions:

- `layout()` wraps children without consuming any of the path
- `route()` matches one segment (`":name"` segments become params)
- `index()` matches when the path is exhausted.

This example uses the Preact adapter from `adapters/preact.js`, which gives you two components: `<Router>` subscribes to the router and renders the match tree, and `<Outlet>` renders the next matched child inside a layout. Route components receive `params` and `data` (the loader result) as props.

```jsx
import { render } from "preact";
import TinyRouter, { layout, route, index } from "./tinyrouter.js";
import { Router, Outlet } from "./adapters/preact.js";

function Shell() {
	return (
		<div>
			<nav>
				<a href="/">Home</a>
				<a href="/posts/hello">First post</a>
			</nav>
			<Outlet />
		</div>
	);
}

function Post({ params, data }) {
	return (
		<article>
			<h3>{params.slug}</h3>
			<p>{data.body}</p>
		</article>
	);
}

const routes = layout({ component: Shell }, [
	index({ component: () => <p>Welcome.</p> }),
	route("posts", {}, [
		route(":slug", {
			component: Post,
			loader: ({ params, signal }) =>
				fetch(`/api/posts/${params.slug}`, { signal }).then(r => r.json())
		})
	])
]);

const router = new TinyRouter(routes);
render(<Router router={router} />, document.getElementById("app"));
```

Those are plain `<a href>` links inside `Shell` — no `Link` component and no click handlers. The router intercepts them (along with back/forward and programmatic navigations) through the Navigation API, which it requires. For programmatic navigation there's `router.push("/posts/hello")` and `router.replace(...)`.

If a loader throws, `<Router>` renders its optional `fallback={error => ...}` prop instead of the tree. To reach the router from a component (for `push`, `href`, `preload`), consume the exported `RouterContext` — `useContext(RouterContext)` in a function component, or `static contextType = RouterContext` in a class.

tinyrouter itself is framework-agnostic: the core has no rendering and exposes everything adapters need through `subscribe()`, `getSnapshot()`, and the match tree. To use it without a framework, see [`examples/basic.html`](examples/basic.html), which renders the match tree by hand.

Runnable, build-free versions of these examples are in [`examples/`](examples/) — serve the repo root (`npx serve`) and open [`examples/preact.html`](examples/preact.html) or [`examples/basic.html`](examples/basic.html).

## Defining routes

A route tree is built from three node types.

### Routes

Most routes are defined using the `route` function. Each route matches one path segment:

```js
import { route } from "./tinyrouter.js";

// matches "/about"
route("about", { component: About });
```

### Nested routes

To create nested routes, pass an array of additional routes as the last argument. Each child matches the next path segment:

```js
import { route } from "./tinyrouter.js";

// matches "/posts/hello" with params.slug === "hello"
// (but not "/posts" by itself — see index routes below)
route("posts", {}, [route(":slug", { component: Post })]);
```

### Layout routes

To nest route components _without_ adding an additional path segment, use the `layout` function. Its component renders for every matched child:

```js
import { layout, route } from "./tinyrouter.js";

// Shell wraps both "/about" and "/contact"
layout({ component: Shell }, [
	route("about", { component: About }),
	route("contact", { component: Contact })
]);
```

### Index routes

To define a route when a _parent's_ path is matched exactly, use the `index` function:

```js
import { index, route } from "./tinyrouter.js";

route("posts", { component: PostsLayout }, [
	// matches "/posts" exactly
	index({ component: PostList }),
	// matches "/posts/hello"
	route(":slug", { component: Post })
]);
```

Without an index child, a route with children matches only when a child consumes the rest of the path.

### Dynamic segments

A `":param"` path matches any segment and captures its value into `params` under that name:

```js
import { route } from "./tinyrouter.js";

// matches "/ada", "/grace", … with the segment in params.name
route(":name", { component: ({ params }) => `<p>Hello, ${params.name}!</p>` });
```

Because a dynamic segment matches anything, put static siblings before it — children are tried in order and the first match wins.

Params accumulate down the tree, and their types are inferred from the `":param"` segments — ancestors included — even in plain JavaScript, via JSDoc:

```js
route(":org", {}, [
	route(":repo", {
		// params is typed { org: string; repo: string } — inferred from the path
		loader: ({ params, signal }) =>
			fetch(`/api/${params.org}/${params.repo}`, { signal }).then(r => r.json())
	})
]);
```

### Lazy loading

To load a route's code only when it's visited, wrap its component in `lazy`, passing a function that returns a promise for the component:

```js
import { route, lazy } from "./tinyrouter.js";

route(":slug", {
	component: lazy(() => import("./post.js").then(m => m.default))
});
```

## Navigating

- It's just links: <a href> is intercepted automatically
- push() / replace() for programmatic navigation
- href() for building URLs (matters under `prefix`)
- The `prefix` option for apps mounted under a subpath

## Loaders and data

- Loader contract: runs on _every_ navigation, receives
  { params, searchParams, signal }
- No cache, on purpose: freshness belongs to the data layer
  (HTTP cache, query library); preload() warms whatever
  cache
  the loader uses
- Subscribable results: return anything with subscribe(cb)
  → unsub
  and the router re-renders on emit while the route is
  matched
- AbortSignal: aborts on supersession/dispose — pass it to
  fetch
- reload() as the manual revalidation escape hatch
- Error handling: a throwing loader puts the error on state
- Point at examples/loaders.html

## Router state

- RouterState shape: { match, navigation, error }
- subscribe()/getSnapshot() — the framework-agnostic
  contract
  (works with useSyncExternalStore)
- The match tree (MatchNode) for anyone introspecting

## Preact adapter

- <Router router={...} fallback={...}> and <Outlet>
- Components receive { params, data } as props — no
  useParams/
  useLoaderData equivalents needed
- RouterContext is the public API for reaching the router:
  useContext(RouterContext) or static contextType =
  RouterContext
- Recipe: a loading indicator (subscribe to navigation
  status) —
  the one pattern that needs real plumbing
- Point at examples/preact.html

## Lifecycle

- dispose(): removes listeners, aborts in-flight loads,
  unsubscribes

## Non-goals / design notes

- No Link component, no data cache, no nested URL
  ranking/wildcards,
  no history-API fallback — and the one-sentence reason for
  each
