/**
 * Maps a path segment to the params it contributes. ":id" → {id: string}, "users" → {}.
 *
 * @template {string} P
 * @typedef {P extends `:${infer K}` ? { [Q in K]: string } : {}} ExtractParams
 */

/**
 * Runs on every navigation to its route — the router never caches results. If the resolved value is
 * a Subscribable (has a `subscribe` method), the router subscribes while the route stays matched
 * and re-notifies its own listeners whenever the value emits.
 *
 * @template {Record<string, string>} P
 * @template D
 * @typedef {(args: {
 * 	params: P;
 * 	searchParams: URLSearchParams;
 * 	signal: AbortSignal;
 * }) => D | Promise<D>} Loader
 */

/**
 * @template {Record<string, string>} P
 * @template D
 * @typedef {(props: {
 * 	params: P;
 * 	data: D;
 * 	pathname: string;
 * 	searchParams: URLSearchParams;
 * 	navigation: "idle" | "loading";
 * 	error: unknown;
 * }) => unknown} RouteComponent
 */

/**
 * @template {RouteComponent<any, any>} C
 * @typedef {{ [LAZY]: true; load: () => Promise<C> }} LazyRoute
 */

/**
 * @template {Record<string, string>} P
 * @template D
 * @typedef {object} RouteMeta
 * @property {RouteComponent<P, D> | LazyRoute<RouteComponent<P, D>>} [component]
 * @property {Loader<P, D>} [loader]
 */

/**
 * The runtime route node. `Needs` is a phantom contravariant marker for the params this subtree
 * expects from its ancestors — used purely for type inference, never present at runtime.
 *
 * @template {Record<string, string>} [Needs={}]
 * @typedef {object} RouteNode
 * @property {"layout" | "route" | "index" | "splat"} type
 * @property {string | null} path
 * @property {RouteMeta<any, any>} meta
 * @property {RouteNode[]} children
 * @property {(_: Needs) => void} [_]
 */

/**
 * @typedef {object} MatchNode
 * @property {RouteNode} route
 * @property {Record<string, string>} params
 * @property {RouteComponent<any, any> | undefined} component Resolved on each navigation; undefined
 *   if the route has none or its lazy load failed.
 * @property {unknown} data
 * @property {unknown} error Non-null when this route's own loader threw or its lazy load failed.
 * @property {MatchNode[]} children
 */

/**
 * `pathname` and `searchParams` are the committed location — router-relative (prefix stripped) and
 * updated only when a navigation commits, so they always describe `match`.
 *
 * @typedef {object} RouterState
 * @property {MatchNode | null} match
 * @property {"idle" | "loading"} navigation
 * @property {unknown} error
 * @property {string} pathname
 * @property {URLSearchParams} searchParams
 */

const LAZY = Symbol("lazy");

/**
 * Wraps a component to be fetched on demand.
 *
 * @template {RouteComponent<any, any>} C
 * @param {() => Promise<C>} load
 * @returns {LazyRoute<C>}
 */
export function lazy(load) {
	return { [LAZY]: true, load };
}

/** @param {unknown} value @returns {value is LazyRoute<RouteComponent<any, any>>} */
function isLazy(value) {
	return typeof value === "object" && value !== null && LAZY in value;
}

/**
 * A loader result the router can watch for changes: anything with a Svelte-store-style
 * `subscribe(callback)` that returns an unsubscribe function.
 *
 * @typedef {{ subscribe(callback: () => void): () => void }} Subscribable
 */

/** @param {unknown} value @returns {value is Subscribable} */
function isSubscribable(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (/** @type {any} */ (value).subscribe) === "function"
	);
}

/**
 * @template T
 * @typedef {{ pending: boolean; value: T | undefined; error: unknown } & Subscribable} Deferred
 */

/**
 * Wraps a promise in a subscribable so it can be returned from a loader without blocking
 * navigation. The router re-renders the route when the promise settles.
 *
 * @template T
 * @param {Promise<T>} promise
 * @returns {Deferred<T>}
 */
export function defer(promise) {
	const listeners = new Set();

	const state = /** @type {Deferred<T>} */ ({
		pending: true,
		value: undefined,
		error: undefined,
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		}
	});

	promise
		.then(value => Object.assign(state, { pending: false, value }))
		.catch(error => Object.assign(state, { pending: false, error }))
		.then(() => listeners.forEach(fn => fn()));
	return state;
}

/** @param {string} segment */
function decodeSegment(segment) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

export default class TinyRouter {
	/** @type {RouterState} */
	#state;

	/** @type {Set<() => void>} */
	#listeners = new Set();

	/** @type {RouteNode} */
	#root;

	#abort = new AbortController();

	/**
	 * Unsubscribe functions for subscribable loader data in the current match tree. Replaced
	 * wholesale when a navigation commits so abandoned routes stop notifying.
	 *
	 * @type {(() => void)[]}
	 */
	#unwatch = [];

	/** @type {string} normalized: no trailing slash, "" when unset */
	#prefix = "";

	/** @type {Navigation} */
	#navigation;

	/** @type {EventListener} */
	#onNavigate = e => this.#handleNavigate(/** @type {NavigateEvent} */ (e));

	/**
	 * @param {RouteNode<{}>} root
	 * @param {{ prefix?: string; navigation?: Navigation }} [options]
	 */
	constructor(root, options = {}) {
		this.#root = root;
		this.#prefix = (options.prefix ?? "").replace(/\/$/, "");

		this.#navigation = options.navigation ?? globalThis.navigation;
		if (!this.#navigation) throw new Error("TinyRouter requires the Navigation API");

		const url = this.#location();
		this.#state = {
			match: null,
			navigation: "idle",
			error: null,
			pathname: this.#strip(url.pathname),
			searchParams: url.searchParams
		};

		// The Navigation API is the single intercept point: plain <a href> clicks,
		// programmatic push/replace, and back/forward all funnel through the
		// navigate event.
		this.#navigation.addEventListener("navigate", this.#onNavigate);

		this.#sync();
	}

	/** @returns {URL} The current location, derived from the Navigation API */
	#location() {
		return new URL(/** @type {string} */ (this.#navigation.currentEntry?.url));
	}

	/** Matches and resolves the current location. */
	#sync() {
		const url = this.#location();
		return this.#navigate(this.#strip(url.pathname), url.searchParams);
	}

	/** @param {NavigateEvent} e */
	#handleNavigate(e) {
		if (!e.canIntercept || e.hashChange || e.downloadRequest !== null) return;
		const url = new URL(e.destination.url);
		if (url.origin !== this.#location().origin) return;
		// Only intercept paths covered by our prefix; let the browser handle the rest.
		if (
			this.#prefix &&
			url.pathname !== this.#prefix &&
			!url.pathname.startsWith(this.#prefix + "/")
		)
			return;
		const pathname = this.#strip(url.pathname);
		if (!this.#match(pathname)) return;
		e.intercept({
			handler: () => this.#navigate(pathname, url.searchParams, e.signal)
		});
	}

	dispose() {
		this.#abort.abort();
		this.#navigation.removeEventListener("navigate", this.#onNavigate);
		this.#unsubscribeAll();
		this.#listeners.clear();
	}

	/**
	 * Strips the prefix from a browser pathname before matching. Paths outside the prefix are
	 * returned unchanged so they fail to match (rather than being silently rewritten).
	 *
	 * @param {string} pathname
	 */
	#strip(pathname) {
		if (!this.#prefix) return pathname;
		if (pathname === this.#prefix) return "/";
		if (pathname.startsWith(this.#prefix + "/")) return pathname.slice(this.#prefix.length);
		return pathname;
	}

	/**
	 * Builds a browser URL string from a router-relative pathname + search. Useful for `<a href>` so
	 * the link's hover preview shows the real URL.
	 *
	 * @param {string} pathname
	 * @param {URLSearchParams} [searchParams]
	 */
	href(pathname, searchParams) {
		const path = pathname === "/" ? this.#prefix || "/" : this.#prefix + pathname;
		const search = searchParams?.toString();
		return search ? `${path}?${search}` : path;
	}

	/**
	 * @param {() => void} fn
	 * @returns {() => void}
	 */
	subscribe(fn) {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** @returns {RouterState} */
	getSnapshot() {
		return this.#state;
	}

	/** @param {string} pathname @param {URLSearchParams} [searchParams] */
	push(pathname, searchParams = new URLSearchParams()) {
		this.#go(pathname, searchParams, false);
	}

	/** @param {string} pathname @param {URLSearchParams} [searchParams] */
	replace(pathname, searchParams = new URLSearchParams()) {
		this.#go(pathname, searchParams, true);
	}

	/**
	 * @param {string} pathname
	 * @param {URLSearchParams} searchParams
	 * @param {boolean} replace
	 */
	#go(pathname, searchParams, replace) {
		this.#navigation.navigate(this.href(pathname, searchParams), {
			history: replace ? "replace" : "auto"
		});
	}

	/**
	 * Resolves lazy components and runs loaders for `pathname` without affecting the current view.
	 *
	 * @param {string} pathname
	 * @param {URLSearchParams} [searchParams]
	 */
	async preload(pathname, searchParams = new URLSearchParams()) {
		const url = new URL(pathname, this.#location());
		if (arguments.length > 1) url.search = searchParams.toString();
		const matched = this.#match(this.#strip(url.pathname));

		// a preload isn't tied to a navigation, so nothing ever aborts its signal
		if (matched) await this.#resolve(matched, url.searchParams, new AbortController().signal);
	}

	/** Re-matches and re-runs all loaders for the current URL. */
	reload() {
		return this.#sync();
	}

	/**
	 * @param {string} pathname
	 * @param {URLSearchParams} searchParams
	 * @param {AbortSignal} [signal]
	 */
	async #navigate(pathname, searchParams, signal) {
		this.#abort.abort();
		const abort = (this.#abort = new AbortController());
		signal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;

		const matched = this.#match(pathname);

		if (matched) {
			this.#state = { ...this.#state, navigation: "loading" };
			this.#notify();
			await this.#resolve(matched, searchParams, signal);
		}

		if (this.#abort !== abort) return;
		if (signal.aborted) {
			this.#state = { ...this.#state, navigation: "idle" };
			this.#notify();
			return;
		}

		// A failure with no component to render it fails the navigation as a whole.
		const error = matched ? this.#unhandled(matched) : null;

		this.#unsubscribeAll();
		if (error != null) {
			this.#state = { match: null, navigation: "idle", error, pathname, searchParams };
		} else {
			this.#state = { match: matched, navigation: "idle", error: null, pathname, searchParams };
			if (matched) this.#watch(matched);
		}
		this.#notify();
	}

	/**
	 * Resolves lazy components and runs loaders in parallel for each node.
	 *
	 * @param {MatchNode} node
	 * @param {URLSearchParams} searchParams
	 * @param {AbortSignal} signal
	 */
	async #resolve(node, searchParams, signal) {
		await Promise.all([
			this.#resolveComponent(node),
			this.#runLoader(node, searchParams, signal),
			...node.children.map(child => this.#resolve(child, searchParams, signal))
		]);
	}

	/**
	 * @param {MatchNode} node
	 * @returns {Promise<void>}
	 */
	async #resolveComponent(node) {
		const c = node.route.meta.component;
		try {
			node.component = isLazy(c) ? await c.load() : c;
		} catch (error) {
			// Without its component the route can't render anything, so a load
			// failure outranks any loader error on the same node.
			node.error = error;
		}
	}

	/**
	 * @param {MatchNode} node
	 * @param {URLSearchParams} searchParams
	 * @param {AbortSignal} signal
	 * @returns {Promise<void>}
	 */
	async #runLoader(node, searchParams, signal) {
		const loader = node.route.meta.loader;
		if (!loader) return;

		try {
			node.data = await loader({ params: node.params, searchParams, signal });
		} catch (error) {
			node.error ??= error;
		}
	}

	/**
	 * Returns the first error on a node without a component, or null.
	 *
	 * @param {MatchNode} node
	 * @returns {unknown}
	 */
	#unhandled(node) {
		if (node.error != null && !node.component) return node.error;

		for (const child of node.children) {
			const error = this.#unhandled(child);
			if (error != null) return error;
		}
		return null;
	}

	/**
	 * Subscribes to any subscribable loader data in the committed match tree.
	 *
	 * @param {MatchNode} node
	 */
	#watch(node) {
		if (isSubscribable(node.data)) {
			const unsubscribe = node.data.subscribe(() => {
				// fresh snapshot identity so getSnapshot-comparing subscribers re-render
				this.#state = { ...this.#state };
				this.#notify();
			});
			this.#unwatch.push(unsubscribe);
		}

		for (const child of node.children) this.#watch(child);
	}

	#unsubscribeAll() {
		for (const unsubscribe of this.#unwatch) unsubscribe();
		this.#unwatch = [];
	}

	#notify() {
		for (const listener of this.#listeners) listener();
	}

	/**
	 * @param {string} pathname
	 * @returns {MatchNode | null}
	 */
	#match(pathname) {
		const segments = pathname.split("/").filter(Boolean).map(decodeSegment);
		return this.#matchNode(this.#root, segments, {});
	}

	/**
	 * @param {RouteNode} node
	 * @param {string[]} segments
	 * @param {Record<string, string>} params
	 * @returns {MatchNode | null}
	 */
	#matchNode(node, segments, params) {
		// Each node type decides how much of the path it consumes (layouts: nothing,
		// indexes: only match when nothing is left, routes: one segment, splats:
		// everything left), then the shared tail matches whatever remains against
		// the node's children.
		if (node.type === "index" && segments.length !== 0) return null;

		if (node.type === "splat") {
			params = { ...params, "*": segments.join("/") };
			segments = [];
		}

		if (node.type === "route") {
			const [segment, ...rest] = segments;
			if (segment === undefined || !node.path) return null;
			if (node.path.startsWith(":")) params = { ...params, [node.path.slice(1)]: segment };
			else if (node.path !== segment) return null;
			segments = rest;
		}

		const children = this.#matchChildren(node.children, segments, params);
		return (
			children && {
				route: node,
				params,
				component: undefined,
				data: undefined,
				error: null,
				children
			}
		);
	}

	/**
	 * @param {RouteNode[]} nodes
	 * @param {string[]} segments
	 * @param {Record<string, string>} params
	 * @returns {MatchNode[] | null}
	 */
	#matchChildren(nodes, segments, params) {
		// Leaf node: no further routes to try. The match is valid only if every
		// segment has been consumed; remaining segments mean a deeper path that
		// isn't defined.
		if (nodes.length === 0) return segments.length === 0 ? [] : null;
		for (const node of nodes) {
			const match = this.#matchNode(node, segments, params);
			if (match) return [match];
		}
		return null;
	}
}

/**
 * Internal untyped constructor; the builders below layer the param-inference types on top.
 *
 * @param {RouteNode["type"]} type
 * @param {string | null} path
 * @param {RouteNode["meta"]} meta
 * @param {RouteNode<any>[]} children
 * @returns {RouteNode<any>}
 */
function createNode(type, path, meta, children) {
	return { type, path, meta, children };
}

/**
 * @template {Record<string, string>} [Inherited={}]
 * @template [D=unknown]
 * @param {RouteMeta<Inherited, D>} meta
 * @param {RouteNode<Inherited>[]} [children]
 * @returns {RouteNode<Inherited>}
 */
export function layout(meta, children = []) {
	return createNode("layout", null, meta, children);
}

/**
 * @template {string} P
 * @template {Record<string, string>} [Inherited={}]
 * @template [D=unknown]
 * @param {P} path
 * @param {RouteMeta<Inherited & ExtractParams<P>, D>} meta
 * @param {RouteNode<Inherited & ExtractParams<P>>[]} [children]
 * @returns {RouteNode<Inherited>}
 */
export function route(path, meta, children = []) {
	return createNode("route", path, meta, children);
}

/**
 * @template {Record<string, string>} [Inherited={}]
 * @template [D=unknown]
 * @param {RouteMeta<Inherited, D>} meta
 * @returns {RouteNode<Inherited>}
 */
export function index(meta) {
	return createNode("index", null, meta, []);
}

/**
 * Matches the rest of the path — zero or more segments — and captures it (decoded, joined with "/")
 * into `params["*"]`. Because children are tried in order, place a splat after its siblings to use
 * it as a catch-all.
 *
 * @template {Record<string, string>} [Inherited={}]
 * @template [D=unknown]
 * @param {RouteMeta<Inherited & { "*": string }, D>} meta
 * @returns {RouteNode<Inherited>}
 */
export function splat(meta) {
	return createNode("splat", null, meta, []);
}
