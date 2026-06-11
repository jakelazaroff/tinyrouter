/**
 * Maps a path segment to the params it contributes. ":id" → {id: string}, "users" → {}.
 *
 * @template {string} P
 * @typedef {P extends `:${infer K}` ? { [Q in K]: string } : {}} ExtractParams
 */

/**
 * @template {Record<string, string>} P
 * @template D
 * @typedef {(args: { params: P; searchParams: URLSearchParams }) => D | Promise<D>} Loader
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
 * expects to receive from its ancestors — used purely for type inference, never present at
 * runtime.
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
 * @property {unknown} loaderData
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
 * @param {MatchNode} node
 * @param {URLSearchParams} searchParams
 * @returns {string}
 */
function cacheKey(node, searchParams) {
	// The cache itself is keyed by RouteNode identity, so the key only needs to
	// capture params and search. Serializing searchParams directly (rather than
	// via Object.fromEntries) preserves repeated keys like ?tag=a&tag=b.
	return JSON.stringify(node.params) + "?" + searchParams;
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

	/**
	 * Loader data, keyed by RouteNode identity (stable across matches). Each entry remembers the
	 * cache key it was loaded for so a change in params or search invalidates the entry.
	 *
	 * @type {Map<RouteNode, { key: string; data: unknown }>}
	 */
	#loaderCache = new Map();

	/** @type {string} normalized: no trailing slash, "" when unset */
	#prefix = "";

	/** @type {Navigation} */
	#navigation;

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
		this.#navigation.addEventListener("navigate", e => this.#onNavigate(e));

		this.#sync();
	}

	/** @returns {URL} The current location, derived from the Navigation API */
	#location() {
		return new URL(/** @type {string} */ (this.#navigation.currentEntry?.url));
	}

	/** Matches and resolves the current location. */
	#sync() {
		const url = this.#location();
		this.#navigate(this.#strip(url.pathname), url.searchParams);
	}

	/** @param {NavigateEvent} e */
	#onNavigate(e) {
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
			handler: () => this.#navigate(this.#strip(url.pathname), url.searchParams)
		});
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
	 * Results land in the same cache navigation uses, so a later push/replace to a matching path
	 * skips refetching.
	 *
	 * @param {string} pathname
	 * @param {URLSearchParams} [searchParams]
	 */
	async preload(pathname, searchParams = new URLSearchParams()) {
		const matched = this.#match(pathname);
		if (matched) await this.#resolve(matched, searchParams);
	}

	/**
	 * @param {string} pathname
	 * @param {URLSearchParams} searchParams
	 */
	async #navigate(pathname, searchParams) {
		const id = ++this.#navigationId;

		const matched = this.#match(pathname);

		if (matched) {
			this.#state = { ...this.#state, navigation: "loading" };
			this.#notify();

			try {
				await this.#resolve(matched, searchParams);
			} catch (error) {
				if (id !== this.#navigationId) return;
				this.#state = { match: null, navigation: "idle", error };
				this.#notify();
				return;
			}
		}

		if (id !== this.#navigationId) return;

		this.#state = { match: matched, navigation: "idle", error: null };
		this.#notify();
	}

	/**
	 * Resolves lazy components and runs loaders in parallel for each node. Cache hits (same RouteNode
	 * + same cacheKey) skip the loader call.
	 *
	 * @param {MatchNode} node
	 * @param {URLSearchParams} searchParams
	 */
	async #resolve(node, searchParams) {
		await Promise.all([
			this.#resolveLazy(node),
			this.#runLoader(node, searchParams),
			...node.children.map(child => this.#resolve(child, searchParams))
		]);
	}

	/**
	 * @param {MatchNode} node
	 * @returns {Promise<void>}
	 */
	async #resolveLazy(node) {
		const c = node.route.meta.component;
		if (isLazy(c)) {
			node.route.meta.component = await c.load();
		}
	}

	/**
	 * @param {MatchNode} node
	 * @param {URLSearchParams} searchParams
	 * @returns {Promise<void>}
	 */
	async #runLoader(node, searchParams) {
		const loader = node.route.meta.loader;
		if (!loader) return;
		const key = cacheKey(node, searchParams);
		const cached = this.#loaderCache.get(node.route);
		if (cached && cached.key === key) {
			node.loaderData = cached.data;
			return;
		}
		node.loaderData = await loader({ params: node.params, searchParams });
		this.#loaderCache.set(node.route, { key, data: node.loaderData });
	}

	#notify() {
		for (const listener of this.#listeners) listener();
	}

	/**
	 * @param {string} pathname
	 * @returns {MatchNode | null}
	 */
	#match(pathname) {
		const segments = pathname.split("/").filter(Boolean);
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
		return children && { route: node, params, loaderData: undefined, children };
	}

	/**
	 * Siblings are tried in order and the first match wins, so a `:param` route listed before a
	 * static sibling (e.g. `:id` before `new`) will shadow it.
	 *
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
