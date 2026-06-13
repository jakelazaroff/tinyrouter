# tinyrouter

tinyrouter is a tiny framework-agnostic client-side router in a single file vanilla JavaScript file.

## Installation

tinyrouter is meant to be [vendored](https://htmx.org/essays/vendoring/); simply copy and paste `tinyrouter.js` into your project!

## Defining routes

A route tree is built from four node types, created as the first argument to `TinyRouter`:

```js
import TinyRouter, { route } from "./tinyrouter.js";

const router = new TinyRouter(route("home", { component: Home }));
```

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

### Catch-all routes

A `splat` matches the rest of the path — zero or more segments — and captures it (decoded, joined with `/`) into `params["*"]`:

```js
import { route, splat } from "./tinyrouter.js";

// matches "/docs", "/docs/guides", "/docs/guides/routing", …
route("docs", {}, [splat({ component: ({ params }) => `<p>${params["*"]}</p>` })]);
```

Because children are tried in order, a splat placed after its siblings makes a natural not-found route that keeps its ancestors' layouts rendered:

```js
import { layout, index, route, splat } from "./tinyrouter.js";

layout({ component: Shell }, [
	index({ component: Home }),
	route("about", { component: About }),
	// any other path, still wrapped in Shell
	splat({ component: NotFound })
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

The navigation waits for the load just like it waits for loaders, so the previous page stays up until the new route can actually render. The load function runs on every navigation to the route, with the router caching nothing: `import()` makes repeat loads free via the module cache, and a failed load is naturally retried on the next visit.

An uncaught load failure fails the navigation like any other unrenderable error. To show the error in the route's place instead, recover inside the load function by resolving to a component:

```js
route(":slug", {
	component: lazy(() =>
		import("./post.js")
			.then(m => m.default)
			.catch(error => () => `<p>Couldn't load this page: ${error}</p>`)
	)
});
```

## Component props

Adapters render every matched route component with the same props:

- `params` — the accumulated path params, ancestors included
- `data` — whatever the route's loader returned (see below)
- `pathname` — the current router-relative pathname (prefix stripped)
- `searchParams` — the current query string, as `URLSearchParams`
- `navigation` — `"loading"` while a navigation is in flight, otherwise `"idle"`
- `error` — the route's own loader error (in which case `data` is undefined), otherwise `null`

`pathname` and `searchParams` always describe the _committed_ match: while a navigation is loading, the previous view stays rendered (with `navigation: "loading"`), and they update when the new match commits.

```js
route("search", {
	component: ({ searchParams, navigation }) =>
		navigation === "loading" ? `<p>Searching…</p>` : `<p>Results for ${searchParams.get("q")}</p>`
});
```

## Navigating

tinyrouter doesn't use any special link components for navigation; `<a href>` is intercepted automatically using the [Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API).

If your router is mounted under a subpath, you can use `.href()` to get a prefixed route path:

```js
const router = new TinyRouter(routes, { prefix: "/foo" });

html` <a href=${router.href("/profile")}>Profile</a> `;
```

To navigate programmatically, you can use `.push()` and `.replace()`:

```js
router.push("/posts/hello");
router.replace("/login");
router.push("/search", new URLSearchParams({ q: "routing" }));
```

## Loaders and data

A route can declare a `loader` alongside its component. It receives `{ params, searchParams, signal }`, and whatever it returns (or resolves to) becomes the match node's `data` — adapters pass it to the component as the `data` prop:

```js
import { route } from "./tinyrouter.js";

route(":id", {
	component: Person,
	loader: ({ params, searchParams, signal }) =>
		fetch(`/api/people/${params.id}`, { signal }).then(r => r.json())
});
```

Loaders run on _every_ navigation to their route. When a navigation matches several nested routes, their loaders run in parallel.

The `signal` aborts a loader when a newer navigation supersedes it or when the router is disposed; pass it to `fetch` so abandoned requests are cancelled.

### Subscribable data

If a loader returns anything with a Svelte-store-style `subscribe(callback)` that returns an unsubscribe function, the router subscribes while the route stays matched and re-renders on every emit:

```js
import { route } from "./tinyrouter.js";

// a minimal subscribable: emits every second
class Ticker {
	count = 0;
	#listeners = new Set();

	constructor() {
		setInterval(() => {
			this.count++;
			for (const fn of this.#listeners) fn();
		}, 1000);
	}

	subscribe(fn) {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}
}

route("live", {
	loader: () => new Ticker(),
	component: ({ data }) => `<p>${data.count}s on this page</p>`
});
```

The callback takes no arguments — it just signals "something changed", and components read the current value off `data`. When a navigation moves away from the route, the router unsubscribes.

### Deferred data

Awaiting in a loader is a choice: it tells the router "don't switch pages until this data exists". A navigation commits once every matched loader settles, so one slow loader holds back the whole tree. For known-slow data, opt out by returning a subscribable handle to the in-flight request instead; the loader returns immediately, so the navigation commits immediately; the route renders its own pending state; and the emit re-renders it when the data lands:

```js
import { route, defer } from "./tinyrouter.js";

route(":id", {
	loader: ({ params, signal }) => defer(fetchPost(params.id, { signal })),
	component: ({ data }) => (data.pending ? `<p>Loading…</p>` : `<article>${data.value}</article>`)
});
```

Each loader makes this choice independently: routes that await render complete on arrival, routes that defer own their pending UI. If a deferred fetch settles before the first render, `pending` is already false — no flash.

### Reloading

To re-run the loaders for the current URL by hand, use `.reload()`:

```js
await deletePost(id);
router.reload();
```

### Error handling

If a route's loader throws or rejects, its component still renders with the error in the `error` prop and `data` undefined:

```js
route(":id", {
	loader: ({ params, signal }) => fetchPost(params.id, { signal }),
	component: ({ data, error }) =>
		error ? `<p>Couldn't load the post.</p>` : `<article>${data.title}</article>`
});
```

Errors clear on the next successful navigation; calling `router.reload()` re-runs the loaders to retry.

## Preloading

To preload a route, you can use `.preload()`:

```js
// warm up "/posts/hello" when the link is hovered
const link = document.querySelector("a[href='/posts/hello']");
link.addEventListener("pointerenter", () => router.preload("/posts/hello"));
```

Preloading both runs loaders _and_ fetches any lazy-loaded components for matched route segments.

Note that there is no cache for loader data, so the loader will run again on actual navigation. To take full advantage of preloading, loaders should use a caching strategy — either the browser's built-in cache or some sort of query library. (The same goes for lazy components: the load function runs again on navigation, but for dynamic `import()` the second call is free thanks to the module cache.)

## Router state

- RouterState shape: { match, navigation, error, pathname, searchParams }
- pathname/searchParams are the committed location — router-relative
  (prefix stripped), updated only when a navigation commits, so they
  always describe match
- subscribe()/getSnapshot() — the framework-agnostic
  contract
  (works with useSyncExternalStore)
- The match tree (MatchNode) for anyone introspecting
