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
 * @typedef {(props: { params: P; data: D }) => unknown} RouteComponent
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
 * @property {"layout" | "route" | "index"} type
 * @property {string | null} path
 * @property {RouteMeta<any, any>} meta
 * @property {RouteNode[]} children
 * @property {(_: Needs) => void} [_]
 */

/**
 * @typedef {object} MatchNode
 * @property {RouteNode} route
 * @property {Record<string, string>} params
 * @property {unknown} data
 * @property {MatchNode[]} children
 */

/**
 * @typedef {object} RouterState
 * @property {MatchNode | null} match
 * @property {"idle" | "loading"} navigation
 * @property {unknown} error
 */

const LAZY = Symbol("lazy");

/**
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
	#state = { match: null, navigation: "idle", error: null };

	/** @type {Set<() => void>} */
	#listeners = new Set();

	/** @type {RouteNode} */
	#root;

	/** @type {number} */
	#navigationId = 0;

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
		e.intercept({
			handler: () => this.#navigate(this.#strip(url.pathname), url.searchParams, e.signal)
		});
	}

	dispose() {
		this.#navigationId++;
		this.#abort?.abort();
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
		const id = ++this.#navigationId;

		this.#abort?.abort();
		this.#abort = new AbortController();
		signal = signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal;

		const matched = this.#match(pathname);

		if (matched) {
			this.#state = { ...this.#state, navigation: "loading" };
			this.#notify();

			try {
				await this.#resolve(matched, searchParams, signal);
			} catch (error) {
				if (id !== this.#navigationId) return;
				if (signal.aborted) {
					this.#state = { ...this.#state, navigation: "idle" };
					this.#notify();
					return;
				}
				this.#unsubscribeAll();
				this.#state = { match: null, navigation: "idle", error };
				this.#notify();
				return;
			}
		}

		if (id !== this.#navigationId) return;
		if (signal.aborted) {
			this.#state = { ...this.#state, navigation: "idle" };
			this.#notify();
			return;
		}

		this.#unsubscribeAll();
		this.#state = { match: matched, navigation: "idle", error: null };
		if (matched) this.#watch(matched);
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
			this.#resolveLazy(node),
			this.#runLoader(node, searchParams, signal),
			...node.children.map(child => this.#resolve(child, searchParams, signal))
		]);
	}

	/**
	 * @param {MatchNode} node
	 * @returns {Promise<void>}
	 */
	async #resolveLazy(node) {
		const c = node.route.meta.component;
		if (isLazy(c)) node.route.meta.component = await c.load();
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

		node.data = await loader({ params: node.params, searchParams, signal });
	}

	/**
	 * Subscribes to any subscribable loader data in the committed match tree.
	 *
	 * @param {MatchNode} node
	 */
	#watch(node) {
		if (isSubscribable(node.data)) {
			const unsubscribe = node.data.subscribe(() => this.#notify());
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
		// indexes: only match when nothing is left, routes: one segment), then the
		// shared tail matches whatever remains against the node's children.
		if (node.type === "index" && segments.length !== 0) return null;

		if (node.type === "route") {
			const [segment, ...rest] = segments;
			if (segment === undefined || !node.path) return null;
			if (node.path.startsWith(":")) params = { ...params, [node.path.slice(1)]: segment };
			else if (node.path !== segment) return null;
			segments = rest;
		}

		const children = this.#matchChildren(node.children, segments, params);
		return children && { route: node, params, data: undefined, children };
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
 * @param {RouteNode<Inherited>[]} children
 * @returns {RouteNode<Inherited>}
 */
export function layout(meta, children) {
	return createNode("layout", null, meta, children);
}

/**
 * @template {string} P
 * @template {Record<string, string>} [Inherited={}]
 * @template [D=unknown]
 * @param {P} path
 * @param {RouteMeta<Inherited & ExtractParams<P>, D>} meta
 * @param {RouteNode<Inherited & ExtractParams<P>>[]} children
 * @returns {RouteNode<Inherited>}
 */
export function route(path, meta, children) {
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
