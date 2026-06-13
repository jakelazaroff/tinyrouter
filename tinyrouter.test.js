import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import TinyRouter, { layout, route, index, splat, lazy } from "./tinyrouter.js";

// --- helpers ---

/**
 * Minimal stand-in for the browser's Navigation API. Dispatches intercept-able navigate events;
 * currentEntry only advances when a handler intercepts, and navigate() returns whether it did, so
 * tests can detect navigations the router let fall through. Like the real API, each event carries a
 * signal that aborts when a later navigation supersedes it (or via cancel(), standing in for the
 * browser canceling the navigation itself).
 */
class FakeNavigation extends EventTarget {
	constructor(url = "http://localhost/") {
		super();
		this.currentEntry = { url };
		this.controller = null;
	}

	navigate(url, { formData } = {}) {
		this.controller?.abort();
		this.controller = new AbortController();
		const destination = new URL(url, this.currentEntry.url);
		let intercepted = false;
		const event = Object.assign(new Event("navigate", { cancelable: true }), {
			canIntercept: true,
			hashChange: false,
			downloadRequest: null,
			formData: formData ?? null,
			destination: { url: destination.href },
			signal: this.controller.signal,
			intercept({ handler }) {
				intercepted = true;
				handler();
			}
		});
		this.dispatchEvent(event);
		if (intercepted) this.currentEntry = { url: destination.href };
		return intercepted;
	}

	cancel() {
		this.controller?.abort();
	}
}

/** Resolves once the router reaches navigation: "idle". */
function waitIdle(router) {
	return new Promise(resolve => {
		if (router.getSnapshot().navigation === "idle") {
			resolve();
			return;
		}
		const unsub = router.subscribe(() => {
			if (router.getSnapshot().navigation === "idle") {
				unsub();
				resolve();
			}
		});
	});
}

async function makeRouter(root, pathname = "/", options = {}) {
	const navigation = new FakeNavigation("http://localhost" + pathname);
	const router = new TinyRouter(root, { navigation, ...options });
	await waitIdle(router);
	return router;
}

async function importPreactAdapter() {
	const dir = await mkdtemp(join(tmpdir(), "tinyrouter-preact-"));
	const preactDir = join(dir, "node_modules", "preact");
	await mkdir(preactDir, { recursive: true });
	await writeFile(
		join(preactDir, "package.json"),
		JSON.stringify({ type: "module", main: "index.js" })
	);
	await writeFile(
		join(preactDir, "index.js"),
		`
export function h(type, props, ...children) {
	return { type, props, children };
}

export function createContext(defaultValue) {
	return { defaultValue, Provider: function Provider() {} };
}

export class Component {
	constructor(props) {
		this.props = props;
		this.state = {};
		this.context = null;
	}

	setState(update) {
		this.state = {
			...this.state,
			...(typeof update === "function" ? update(this.state, this.props) : update)
		};
	}
}
`
	);

	const source = await readFile(new URL("./adapters/preact.js", import.meta.url), "utf8");
	const adapterPath = join(dir, "preact-adapter.mjs");
	await writeFile(adapterPath, source);
	return import(pathToFileURL(adapterPath).href);
}

function makeAdapterRouter(label) {
	let listener = null;
	return {
		label,
		subscribed: 0,
		unsubscribed: 0,
		snapshot: { match: null, navigation: "idle", error: null, label },
		getSnapshot() {
			return this.snapshot;
		},
		subscribe(fn) {
			this.subscribed++;
			listener = fn;
			return () => {
				this.unsubscribed++;
				if (listener === fn) listener = null;
			};
		},
		emit() {
			listener?.();
		}
	};
}

describe("route builders", () => {
	it("index() creates an index node with no children", () => {
		const node = index({});
		assert.equal(node.type, "index");
		assert.equal(node.path, null);
		assert.deepEqual(node.children, []);
	});

	it("route() creates a route node with the given path", () => {
		const node = route("about", {}, []);
		assert.equal(node.type, "route");
		assert.equal(node.path, "about");
	});

	it("layout() creates a layout node with null path", () => {
		const node = layout({}, []);
		assert.equal(node.type, "layout");
		assert.equal(node.path, null);
	});

	it("route() and layout() default children to an empty array", () => {
		assert.deepEqual(route("about", {}).children, []);
		assert.deepEqual(layout({}).children, []);
	});

	it("splat() creates a splat node with no children", () => {
		const node = splat({});
		assert.equal(node.type, "splat");
		assert.equal(node.path, null);
		assert.deepEqual(node.children, []);
	});

	it("lazy() stores the load function", () => {
		const load = async () => () => null;
		const wrapped = lazy(load);
		assert.equal(wrapped.load, load);
	});
});

describe("matching", () => {
	it("matches an index route at /", async () => {
		const root = layout({}, [index({})]);
		const router = await makeRouter(root, "/");
		assert.ok(router.getSnapshot().match);
	});

	it("returns null match for an unrecognised path", async () => {
		const root = layout({}, [index({})]);
		const router = await makeRouter(root, "/missing");
		assert.equal(router.getSnapshot().match, null);
	});

	it("matches a leaf route created without children", async () => {
		const root = layout({}, [route("about", { component: () => "about" })]);
		const router = await makeRouter(root, "/about");
		assert.equal(router.getSnapshot().match?.children[0].route.path, "about");
	});

	it("matches a static route segment", async () => {
		const root = layout({}, [route("about", {}, [index({})])]);
		const router = await makeRouter(root, "/about");
		assert.equal(router.getSnapshot().match?.children[0].route.path, "about");
	});

	it("does not match index when extra segments remain", async () => {
		const root = layout({}, [index({})]);
		const router = await makeRouter(root, "/extra");
		assert.equal(router.getSnapshot().match, null);
	});

	it("matches a dynamic param segment", async () => {
		const root = layout({}, [route(":id", {}, [index({})])]);
		const router = await makeRouter(root, "/42");
		assert.equal(router.getSnapshot().match?.children[0].params.id, "42");
	});

	it("decodes dynamic param segments", async () => {
		const root = layout({}, [route(":name", {}, [index({})])]);
		const router = await makeRouter(root, "/Ada%20Lovelace");
		assert.equal(router.getSnapshot().match?.children[0].params.name, "Ada Lovelace");
	});

	it("matches encoded static segments", async () => {
		const root = layout({}, [route("café", {}, [index({})])]);
		const router = await makeRouter(root, "/caf%C3%A9");
		assert.equal(router.getSnapshot().match?.children[0].route.path, "café");
	});

	it("matches nested routes and accumulates params", async () => {
		const root = layout({}, [route("users", {}, [route(":id", {}, [index({})])])]);
		const router = await makeRouter(root, "/users/7");
		const idMatch = router.getSnapshot().match?.children[0].children[0];
		assert.equal(idMatch?.params.id, "7");
	});

	it("does not match a param route when its segment is missing", async () => {
		const root = layout({}, [route("users", {}, [route(":id", {}, [index({})])])]);
		const router = await makeRouter(root, "/users");
		assert.equal(router.getSnapshot().match, null);
	});

	it("tries children in order and stops at first match", async () => {
		const root = layout({}, [route("a", {}, [index({})]), route("b", {}, [index({})])]);
		const router = await makeRouter(root, "/b");
		assert.equal(router.getSnapshot().match?.children[0].route.path, "b");
	});

	it("splat captures the remaining segments into params['*']", async () => {
		const root = layout({}, [route("docs", {}, [splat({})])]);
		const router = await makeRouter(root, "/docs/guides/routing/nested");
		const splatMatch = router.getSnapshot().match?.children[0].children[0];
		assert.equal(splatMatch?.params["*"], "guides/routing/nested");
	});

	it("splat matches zero segments", async () => {
		const root = layout({}, [route("docs", {}, [splat({})])]);
		const router = await makeRouter(root, "/docs");
		const splatMatch = router.getSnapshot().match?.children[0].children[0];
		assert.equal(splatMatch?.params["*"], "");
	});

	it("splat decodes captured segments", async () => {
		const root = layout({}, [splat({})]);
		const router = await makeRouter(root, "/Ada%20Lovelace/caf%C3%A9");
		assert.equal(router.getSnapshot().match?.children[0].params["*"], "Ada Lovelace/café");
	});

	it("splat acts as a catch-all after unmatched siblings", async () => {
		const root = layout({}, [
			index({}),
			route("about", {}, [index({})]),
			splat({ component: () => "not found" })
		]);
		const router = await makeRouter(root, "/no/such/page");
		const match = router.getSnapshot().match;
		assert.equal(match?.children[0].route.type, "splat");
		assert.equal(match?.children[0].params["*"], "no/such/page");
	});

	it("earlier siblings win over a splat", async () => {
		const root = layout({}, [route("about", {}, [index({})]), splat({})]);
		const router = await makeRouter(root, "/about");
		assert.equal(router.getSnapshot().match?.children[0].route.path, "about");
	});
});

describe("loaders", () => {
	it("runs the loader and stores data on the match node", async () => {
		const root = layout({}, [index({ loader: async () => ({ value: 42 }) })]);
		const router = await makeRouter(root, "/");
		assert.deepEqual(router.getSnapshot().match?.children[0].data, { value: 42 });
	});

	it("passes params and searchParams to the loader", async () => {
		let received = null;
		const root = layout({}, [
			route(":id", {}, [
				index({
					loader: async args => {
						received = args;
						return null;
					}
				})
			])
		]);
		const _router = await makeRouter(root, "/5");
		assert.deepEqual(received?.params, { id: "5" });
		assert.ok(received?.searchParams instanceof URLSearchParams);
	});

	it("re-runs loaders on every navigation", async () => {
		let callCount = 0;
		const root = layout({}, [
			index({}),
			route("about", {}, [
				index({
					loader: async () => {
						callCount++;
						return "data";
					}
				})
			])
		]);
		const router = await makeRouter(root, "/");

		router.push("/about");
		await waitIdle(router);
		assert.equal(callCount, 1);

		router.push("/");
		await waitIdle(router);

		// The router keeps no data cache: navigating back runs the loader again,
		// so freshness is the data layer's responsibility.
		router.push("/about");
		await waitIdle(router);
		assert.equal(callCount, 2);
	});

	it("stores a loader error in state and clears the match", async () => {
		const root = layout({}, [
			index({
				loader: async () => {
					throw new Error("oops");
				}
			})
		]);
		const router = await makeRouter(root, "/");
		const { error, match } = router.getSnapshot();
		assert.ok(error instanceof Error);
		assert.equal(/** @type {Error} */ (error).message, "oops");
		assert.equal(match, null);
	});
});

describe("errors", () => {
	const boom = message => async () => {
		throw new Error(message);
	};

	it("delivers a loader error to the failing route's component", async () => {
		const root = layout({}, [index({ component: () => null, loader: boom("oops") })]);
		const router = await makeRouter(root, "/");

		const { match, error } = router.getSnapshot();
		assert.equal(error, null);
		assert.ok(match);
		assert.equal(match.error, null);
		assert.equal(match.children[0].error?.message, "oops");
	});

	it("fails the navigation when the failing route has no component", async () => {
		const root = layout({ component: () => null }, [
			route("a", { loader: boom("oops") }, [index({ component: () => null })])
		]);
		const router = await makeRouter(root, "/a");

		const { match, error } = router.getSnapshot();
		assert.equal(match, null);
		assert.equal(error?.message, "oops");
	});

	it("fails the navigation when a lazy component fails to load", async () => {
		const root = layout({ component: () => null }, [
			index({
				component: lazy(async () => {
					throw new Error("no module");
				})
			})
		]);
		const router = await makeRouter(root, "/");

		const { match, error } = router.getSnapshot();
		assert.equal(match, null);
		assert.equal(error?.message, "no module");
	});

	it("a failed lazy load outranks the same route's loader error", async () => {
		const root = layout({ component: () => null }, [
			index({
				component: lazy(async () => {
					throw new Error("no module");
				}),
				loader: boom("oops")
			})
		]);
		const router = await makeRouter(root, "/");

		assert.equal(router.getSnapshot().error?.message, "no module");
	});

	it("keeps simultaneous errors at multiple levels independent", async () => {
		const root = layout({}, [
			route("a", { component: () => null, loader: boom("outer") }, [
				index({ component: () => null, loader: boom("inner") })
			])
		]);
		const router = await makeRouter(root, "/a");

		const { match, error } = router.getSnapshot();
		assert.equal(error, null);
		assert.equal(match?.children[0].error?.message, "outer");
		assert.equal(match?.children[0].children[0].error?.message, "inner");
	});

	it("reports the topmost error when several routes can't render theirs", async () => {
		const root = layout({ component: () => null }, [
			route("a", { loader: boom("outer") }, [index({ loader: boom("inner") })])
		]);
		const router = await makeRouter(root, "/a");

		assert.equal(router.getSnapshot().match, null);
		assert.equal(router.getSnapshot().error?.message, "outer");
	});

	it("keeps an errored route's children matched and loaded", async () => {
		const root = layout({}, [
			route("a", { component: () => null, loader: boom("oops") }, [
				index({ component: () => null, loader: async () => "ok" })
			])
		]);
		const router = await makeRouter(root, "/a");

		const a = router.getSnapshot().match?.children[0];
		assert.equal(a?.error?.message, "oops");
		assert.equal(a?.children[0].data, "ok");
	});

	it("fails the navigation when no component can render the error", async () => {
		const root = layout({}, [index({ loader: boom("oops") })]);
		const router = await makeRouter(root, "/");

		const { match, error } = router.getSnapshot();
		assert.equal(match, null);
		assert.equal(error?.message, "oops");
	});

	it("clears a settled error on the next successful navigation", async () => {
		const root = layout({}, [
			index({ component: () => null }),
			route("broken", { component: () => null, loader: boom("oops") }, [])
		]);
		const router = await makeRouter(root, "/broken");
		assert.ok(router.getSnapshot().match?.children[0].error);

		router.push("/");
		await waitIdle(router);

		assert.equal(router.getSnapshot().match?.children[0].error, null);
	});
});

describe("actions", () => {
	it("calls the action with formData on a POST navigation", async () => {
		const navigation = new FakeNavigation("http://localhost/");
		const root = layout({}, [index({}), route("contact", { action: ({ formData }) => formData.get("name") }, [index({})])]);
		const router = new TinyRouter(root, { navigation });
		await waitIdle(router);
		const fd = new FormData();
		fd.append("name", "Ada");
		navigation.navigate("/contact", { formData: fd });
		await waitIdle(router);
		assert.equal(router.getSnapshot().match?.children[0].data, "Ada");
	});

	it("runs the loader on a GET navigation, not the action", async () => {
		const navigation = new FakeNavigation("http://localhost/");
		const root = layout({}, [index({}), route("search", { loader: ({ searchParams }) => searchParams.get("q"), action: () => "posted" }, [index({})])]);
		const router = new TinyRouter(root, { navigation });
		await waitIdle(router);
		navigation.navigate("/search?q=hello");
		await waitIdle(router);
		assert.equal(router.getSnapshot().match?.children[0].data, "hello");
	});

	it("runs action on deepest matched node; ancestors run loaders", async () => {
		const navigation = new FakeNavigation("http://localhost/");
		let ancestorRan = null;
		const root = layout({
			loader: () => { ancestorRan = "loader"; },
			action: () => { ancestorRan = "action"; }
		}, [route("submit", { action: ({ formData }) => formData.get("v") }, [index({})])]);
		const router = new TinyRouter(root, { navigation });
		await waitIdle(router);
		const fd = new FormData();
		fd.append("v", "42");
		navigation.navigate("/submit", { formData: fd });
		await waitIdle(router);
		assert.equal(ancestorRan, "loader");
		assert.equal(router.getSnapshot().match?.children[0].data, "42");
	});

	it("action runs before loaders so loaders can depend on its result", async () => {
		const navigation = new FakeNavigation("http://localhost/");
		const order = [];
		const root = layout({
			loader: async () => { order.push("loader"); }
		}, [route("submit", { action: async () => { order.push("action"); } }, [index({})])]);
		const router = new TinyRouter(root, { navigation });
		await waitIdle(router);
		navigation.navigate("/submit", { formData: new FormData() });
		await waitIdle(router);
		assert.deepEqual(order, ["action", "loader"]);
	});

	it("passes searchParams alongside formData to the action", async () => {
		const navigation = new FakeNavigation("http://localhost/");
		const root = layout({}, [index({}), route("submit", { action: ({ searchParams, formData }) => `${searchParams.get("ref")}-${formData.get("v")}` }, [index({})])]);
		const router = new TinyRouter(root, { navigation });
		await waitIdle(router);
		const fd = new FormData();
		fd.append("v", "42");
		navigation.navigate("/submit?ref=home", { formData: fd });
		await waitIdle(router);
		assert.equal(router.getSnapshot().match?.children[0].data, "home-42");
	});
});

describe("lazy", () => {
	it("resolves the component onto the match before the route becomes active", async () => {
		const Comp = () => null;
		const root = layout({}, [index({ component: lazy(async () => Comp) })]);
		const router = await makeRouter(root, "/");
		assert.equal(router.getSnapshot().match?.children[0].component, Comp);
	});

	it("never touches the route meta", async () => {
		const wrapped = lazy(async () => () => null);
		const root = layout({}, [index({ component: wrapped })]);
		const router = await makeRouter(root, "/");
		assert.equal(router.getSnapshot().match?.children[0].route.meta["component"], wrapped);
	});

	it("a load that recovers in userland renders the recovery component in place", async () => {
		const ErrorComp = () => null;
		const load = () => Promise.reject(new Error("no module")).then(undefined, () => ErrorComp);
		const root = layout({}, [index({ component: lazy(load) })]);
		const router = await makeRouter(root, "/");

		const { match, error } = router.getSnapshot();
		assert.equal(error, null);
		assert.equal(match?.children[0].component, ErrorComp);
	});

	it("re-runs the load on every navigation, so a failed load retries", async () => {
		let calls = 0;
		const Comp = () => null;
		const root = layout({}, [
			index({}),
			route(
				"flaky",
				{
					component: lazy(async () => {
						if (++calls === 1) throw new Error("flaky");
						return Comp;
					})
				},
				[]
			)
		]);
		const router = await makeRouter(root, "/");

		router.push("/flaky");
		await waitIdle(router);
		assert.equal(router.getSnapshot().error?.message, "flaky");

		router.push("/flaky");
		await waitIdle(router);
		assert.equal(router.getSnapshot().error, null);
		assert.equal(router.getSnapshot().match?.children[0].component, Comp);
	});
});

describe("push and replace", () => {
	it("push navigates to a new route", async () => {
		const root = layout({}, [index({}), route("about", {}, [index({})])]);
		const router = await makeRouter(root, "/");
		router.push("/about");
		await waitIdle(router);
		assert.equal(router.getSnapshot().match?.children[0].route.path, "about");
	});

	it("replace navigates to a new route", async () => {
		const root = layout({}, [index({}), route("about", {}, [index({})])]);
		const router = await makeRouter(root, "/");
		router.replace("/about");
		await waitIdle(router);
		assert.equal(router.getSnapshot().match?.children[0].route.path, "about");
	});

	it("navigating to an unmatched path is not intercepted", async () => {
		const navigation = new FakeNavigation("http://localhost/");
		const root = layout({}, [index({})]);
		const router = new TinyRouter(root, { navigation });
		await waitIdle(router);
		const before = router.getSnapshot().match;
		assert.equal(navigation.navigate("/gone"), false);
		assert.equal(router.getSnapshot().match, before);
	});
});

describe("location", () => {
	it("exposes pathname and searchParams on the snapshot", async () => {
		const root = layout({}, [route("about", {}, [index({})])]);
		const router = await makeRouter(root, "/about?tag=a");
		const { pathname, searchParams } = router.getSnapshot();
		assert.equal(pathname, "/about");
		assert.equal(searchParams.get("tag"), "a");
	});

	it("updates the location when a navigation commits", async () => {
		const root = layout({}, [index({}), route("about", {}, [index({})])]);
		const router = await makeRouter(root, "/");

		router.push("/about", new URLSearchParams({ tag: "b" }));
		await waitIdle(router);

		assert.equal(router.getSnapshot().pathname, "/about");
		assert.equal(router.getSnapshot().searchParams.get("tag"), "b");
	});

	it("strips the prefix from pathname", async () => {
		const root = layout({}, [route("about", {}, [index({})])]);
		const router = await makeRouter(root, "/app/about", { prefix: "/app" });
		assert.equal(router.getSnapshot().pathname, "/about");
	});

	it("keeps the committed location while a navigation is loading", async () => {
		let release;
		const gate = new Promise(resolve => (release = resolve));
		const root = layout({}, [index({}), route("slow", {}, [index({ loader: () => gate })])]);
		const router = await makeRouter(root, "/");

		router.push("/slow");
		assert.equal(router.getSnapshot().navigation, "loading");
		assert.equal(router.getSnapshot().pathname, "/");

		release(null);
		await waitIdle(router);
		assert.equal(router.getSnapshot().pathname, "/slow");
	});

	it("records the failed navigation's location alongside the error", async () => {
		const root = layout({}, [
			index({}),
			route("broken", {}, [
				index({
					loader: async () => {
						throw new Error("oops");
					}
				})
			])
		]);
		const router = await makeRouter(root, "/");

		router.push("/broken");
		await waitIdle(router);

		assert.ok(router.getSnapshot().error);
		assert.equal(router.getSnapshot().pathname, "/broken");
	});
});

describe("subscribe", () => {
	it("notifies listeners on navigation", async () => {
		const root = layout({}, [index({})]);
		const router = await makeRouter(root, "/");
		let notified = false;
		const unsub = router.subscribe(() => {
			notified = true;
		});
		router.push("/");
		await waitIdle(router);
		unsub();
		assert.ok(notified);
	});

	it("unsubscribing prevents further notifications", async () => {
		const root = layout({}, [index({})]);
		const router = await makeRouter(root, "/");
		let count = 0;
		const unsub = router.subscribe(() => count++);
		unsub();
		router.push("/");
		await waitIdle(router);
		assert.equal(count, 0);
	});
});

describe("href", () => {
	it("returns the pathname unchanged when no prefix is set", async () => {
		const router = await makeRouter(layout({}, [index({})]), "/");
		assert.equal(router.href("/about"), "/about");
	});

	it("prepends the prefix to non-root paths", async () => {
		const router = await makeRouter(layout({}, [index({})]), "/app", { prefix: "/app" });
		assert.equal(router.href("/about"), "/app/about");
	});

	it("maps / to the prefix root", async () => {
		const router = await makeRouter(layout({}, [index({})]), "/app", { prefix: "/app" });
		assert.equal(router.href("/"), "/app");
	});

	it("appends serialised search params", async () => {
		const router = await makeRouter(layout({}, [index({})]), "/");
		assert.equal(router.href("/search", new URLSearchParams({ q: "hi" })), "/search?q=hi");
	});
});

describe("navigation api", () => {
	it("throws when the Navigation API is unavailable", () => {
		assert.throws(() => new TinyRouter(layout({}, [index({})])), /Navigation API/);
	});

	it("does not intercept cross-origin navigations", async () => {
		const navigation = new FakeNavigation();
		const router = new TinyRouter(layout({}, [index({})]), { navigation });
		await waitIdle(router);
		assert.equal(navigation.navigate("http://elsewhere.example/"), false);
	});

	it("only intercepts navigations covered by the prefix", async () => {
		const navigation = new FakeNavigation("http://localhost/app");
		const router = new TinyRouter(layout({}, [index({})]), { navigation, prefix: "/app" });
		await waitIdle(router);
		assert.equal(navigation.navigate("/other"), false);
		assert.equal(navigation.navigate("/app"), true);
	});

	it("dispose removes the Navigation API listener", async () => {
		const navigation = new FakeNavigation();
		const router = new TinyRouter(layout({}, [index({}), route("about", {}, [])]), {
			navigation
		});
		await waitIdle(router);
		router.dispose();
		assert.equal(navigation.navigate("/about"), false);
	});
});

describe("preload", () => {
	it("runs loaders without changing the current match", async () => {
		let callCount = 0;
		const root = layout({}, [
			index({}),
			route("about", {}, [
				index({
					loader: async () => {
						callCount++;
						return "ok";
					}
				})
			])
		]);
		const router = await makeRouter(root, "/");
		const matchBefore = router.getSnapshot().match;

		await router.preload("/about");

		assert.equal(router.getSnapshot().match, matchBefore);
		assert.equal(callCount, 1);
	});

	it("does not cache loader results — a subsequent navigation runs the loader again", async () => {
		let callCount = 0;
		const root = layout({}, [
			index({}),
			route("about", {}, [
				index({
					loader: async () => {
						callCount++;
						return "ok";
					}
				})
			])
		]);
		const router = await makeRouter(root, "/");

		await router.preload("/about");
		router.push("/about");
		await waitIdle(router);

		// Preload exists to warm caches *inside* the loader (HTTP cache, a query
		// library); the router itself deliberately re-runs the loader.
		assert.equal(callCount, 2);
	});

	it("runs lazy loads, but caching them is the load function's concern", async () => {
		let loads = 0;
		const Comp = () => null;
		const root = layout({}, [
			index({}),
			route("about", {}, [
				index({
					component: lazy(async () => {
						loads++;
						return Comp;
					})
				})
			])
		]);
		const router = await makeRouter(root, "/");

		await router.preload("/about");
		router.push("/about");
		await waitIdle(router);

		// Like loaders, lazy loads re-run on the real navigation; preload warms
		// whatever cache backs them (for dynamic import(), the module cache).
		assert.equal(loads, 2);
		assert.equal(router.getSnapshot().match?.children[0].children[0].component, Comp);
	});

	it("does not reject when a loader fails", async () => {
		const root = layout({}, [
			index({}),
			route(
				"broken",
				{
					loader: async () => {
						throw new Error("oops");
					}
				},
				[]
			)
		]);
		const router = await makeRouter(root, "/");
		const matchBefore = router.getSnapshot().match;

		// preload is fire-and-forget warming; the real navigation surfaces the error
		await router.preload("/broken");

		assert.equal(router.getSnapshot().match, matchBefore);
		assert.equal(router.getSnapshot().error, null);
	});

	it("accepts inline search params in the pathname", async () => {
		let received = null;
		const root = layout({}, [
			route(
				"about",
				{
					loader: async ({ searchParams }) => {
						received = searchParams.get("tag");
						return null;
					}
				},
				[]
			)
		]);
		const router = await makeRouter(root, "/");

		await router.preload("/about?tag=a");

		assert.equal(received, "a");
	});

	it("accepts prefixed hrefs", async () => {
		let callCount = 0;
		const root = layout({}, [
			index({}),
			route(
				"about",
				{
					loader: async () => {
						callCount++;
						return null;
					}
				},
				[]
			)
		]);
		const router = await makeRouter(root, "/app", { prefix: "/app" });

		await router.preload(router.href("/about"));

		assert.equal(callCount, 1);
	});
});

describe("reload", () => {
	it("re-runs loaders for the current route and keeps the match", async () => {
		let callCount = 0;
		const root = layout({}, [
			index({
				loader: async () => {
					callCount++;
					return callCount;
				}
			})
		]);
		const router = await makeRouter(root, "/");
		assert.equal(callCount, 1);

		await router.reload();

		assert.equal(callCount, 2);
		assert.equal(router.getSnapshot().match?.children[0].data, 2);
	});

	it("preserves search params", async () => {
		let received = null;
		const root = layout({}, [
			route(
				"about",
				{ loader: async ({ searchParams }) => (received = searchParams.get("tag")) },
				[]
			)
		]);
		const router = await makeRouter(root, "/about?tag=a");

		received = null;
		await router.reload();

		assert.equal(received, "a");
	});

	it("leaves state untouched when the current URL has no match", async () => {
		const root = layout({}, [index({})]);
		const router = await makeRouter(root, "/missing");

		await router.reload();

		assert.equal(router.getSnapshot().match, null);
		assert.equal(router.getSnapshot().error, null);
	});
});

describe("subscribable loader data", () => {
	/** Minimal Svelte-store-contract object: subscribe(fn) returns an unsubscribe function. */
	function makeStore() {
		const subscribers = new Set();
		return {
			subscribed: 0,
			unsubscribed: 0,
			subscribe(fn) {
				this.subscribed++;
				subscribers.add(fn);
				return () => {
					this.unsubscribed++;
					subscribers.delete(fn);
				};
			},
			emit() {
				for (const fn of subscribers) fn();
			}
		};
	}

	it("notifies router listeners when the store emits", async () => {
		const store = makeStore();
		const root = layout({}, [index({ loader: () => store })]);
		const router = await makeRouter(root, "/");

		let notified = 0;
		router.subscribe(() => notified++);
		store.emit();

		assert.equal(store.subscribed, 1);
		assert.equal(notified, 1);
	});

	it("emits replace the snapshot so getSnapshot-comparing subscribers re-render", async () => {
		const store = makeStore();
		const root = layout({}, [index({ loader: () => store })]);
		const router = await makeRouter(root, "/");

		const before = router.getSnapshot();
		store.emit();

		assert.notEqual(router.getSnapshot(), before);
		assert.equal(router.getSnapshot().match, before.match);
	});

	it("unsubscribes when the route is navigated away from", async () => {
		const store = makeStore();
		const root = layout({}, [index({ loader: () => store }), route("about", {}, [index({})])]);
		const router = await makeRouter(root, "/");

		router.push("/about");
		await waitIdle(router);

		let notified = 0;
		router.subscribe(() => notified++);
		store.emit();

		assert.equal(store.unsubscribed, 1);
		assert.equal(notified, 0);
	});

	it("unsubscribes when a later navigation's loader throws", async () => {
		const store = makeStore();
		const root = layout({}, [
			index({ loader: () => store }),
			route("broken", {}, [
				index({
					loader: async () => {
						throw new Error("oops");
					}
				})
			])
		]);
		const router = await makeRouter(root, "/");

		router.push("/broken");
		await waitIdle(router);

		assert.equal(store.unsubscribed, 1);
	});

	it("unsubscribes on dispose", async () => {
		const store = makeStore();
		const root = layout({}, [index({ loader: () => store })]);
		const router = await makeRouter(root, "/");

		router.dispose();

		assert.equal(store.unsubscribed, 1);
	});

	it("does not subscribe during preload", async () => {
		const store = makeStore();
		const root = layout({}, [index({}), route("about", {}, [index({ loader: () => store })])]);
		const router = await makeRouter(root, "/");

		await router.preload("/about");

		assert.equal(store.subscribed, 0);
	});

	it("reload swaps the subscription without duplicating notifications", async () => {
		const store = makeStore();
		const root = layout({}, [index({ loader: () => store })]);
		const router = await makeRouter(root, "/");

		await router.reload();

		// The loader returned the same store, so reload unsubscribes the old
		// callback and subscribes a fresh one — emits must notify exactly once.
		assert.equal(store.subscribed, 2);
		assert.equal(store.unsubscribed, 1);

		let notified = 0;
		router.subscribe(() => notified++);
		store.emit();
		assert.equal(notified, 1);
	});
});

describe("cancellation", () => {
	/** A promise with its resolve/reject exposed, for holding a loader open mid-test. */
	function deferred() {
		let resolve, reject;
		const promise = new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	it("passes an AbortSignal to loaders", async () => {
		let received;
		const root = layout({}, [
			index({
				loader: args => {
					received = args.signal;
				}
			})
		]);
		await makeRouter(root, "/");
		assert.ok(received instanceof AbortSignal);
	});

	it("aborts the loader signal when a new navigation supersedes it", async () => {
		const gate = deferred();
		let captured;
		const root = layout({}, [
			index({}),
			route("slow", {}, [
				index({
					loader: ({ signal }) => {
						captured = signal;
						return gate.promise;
					}
				})
			]),
			route("fast", {}, [index({})])
		]);
		const router = await makeRouter(root, "/");

		router.push("/slow");
		assert.equal(captured.aborted, false);

		router.push("/fast");
		assert.equal(captured.aborted, true);

		// The stale loader finishing late must not disturb the committed navigation.
		gate.resolve("late");
		await waitIdle(router);
		await new Promise(r => setTimeout(r, 0));
		assert.equal(router.getSnapshot().match?.children[0].route.path, "fast");
		assert.equal(router.getSnapshot().navigation, "idle");
	});

	it("dispose aborts the in-flight navigation and never subscribes its data", async () => {
		const gate = deferred();
		let captured;
		const store = {
			subscribed: 0,
			subscribe() {
				this.subscribed++;
				return () => {};
			}
		};
		const root = layout({}, [
			index({}),
			route("slow", {}, [
				index({
					loader: ({ signal }) => {
						captured = signal;
						return gate.promise;
					}
				})
			])
		]);
		const router = await makeRouter(root, "/");

		router.push("/slow");
		router.dispose();
		assert.equal(captured.aborted, true);

		// The loader resolving a subscribable after dispose must not subscribe it —
		// nothing would ever unsubscribe.
		gate.resolve(store);
		await new Promise(r => setTimeout(r, 0));
		assert.equal(store.subscribed, 0);
	});

	it("keeps the current view when the browser cancels a navigation", async () => {
		const gate = deferred();
		const root = layout({}, [
			index({}),
			route("slow", {}, [index({ loader: () => gate.promise })])
		]);
		const navigation = new FakeNavigation("http://localhost/");
		const router = new TinyRouter(root, { navigation });
		await waitIdle(router);
		const before = router.getSnapshot().match;

		router.push("/slow");
		navigation.cancel();
		// A loader that honors the signal rejects once it aborts.
		gate.reject(new DOMException("aborted", "AbortError"));
		await waitIdle(router);

		const { match, navigation: status, error } = router.getSnapshot();
		assert.equal(match, before);
		assert.equal(status, "idle");
		assert.equal(error, null);
	});
});

describe("preact adapter", () => {
	it("passes params, data and the navigation state to route components", async () => {
		const { Router } = await importPreactAdapter();
		const C = () => null;
		const snapshot = {
			match: { route: { meta: {} }, component: C, params: { id: "1" }, data: "d", children: [] },
			navigation: "idle",
			error: null,
			pathname: "/things/1",
			searchParams: new URLSearchParams("q=hi")
		};
		const view = new Router({ router: { getSnapshot: () => snapshot, subscribe: () => () => {} } });

		const tree = view.render();

		// RouterContext.Provider → MatchContext.Provider → component
		const leaf = tree.children[0].children[0];
		assert.equal(leaf.type, C);
		assert.equal(leaf.props.params.id, "1");
		assert.equal(leaf.props.data, "d");
		assert.equal(leaf.props.pathname, "/things/1");
		assert.equal(leaf.props.searchParams.get("q"), "hi");
		assert.equal(leaf.props.navigation, "idle");
		assert.equal(leaf.props.error, null);
	});

	it("Outlet renders the next match with the same navigation state", async () => {
		const { Outlet } = await importPreactAdapter();
		const Child = () => null;
		const child = {
			route: { meta: {} },
			component: Child,
			params: { x: "1" },
			data: 2,
			children: []
		};
		const state = {
			match: null,
			navigation: "loading",
			error: null,
			pathname: "/a/b",
			searchParams: new URLSearchParams()
		};
		const outlet = new Outlet({});
		outlet.context = {
			node: { route: { meta: {} }, params: {}, data: undefined, children: [child] },
			state
		};

		const tree = outlet.render();

		const leaf = tree.children[0];
		assert.equal(leaf.type, Child);
		assert.equal(leaf.props.params.x, "1");
		assert.equal(leaf.props.pathname, "/a/b");
		assert.equal(leaf.props.navigation, "loading");
	});

	it("renders an errored route's component with the error prop", async () => {
		const { Outlet } = await importPreactAdapter();
		const C = () => null;
		const err = new Error("boom");
		const child = {
			route: { meta: {} },
			component: C,
			params: {},
			data: undefined,
			error: err,
			children: [{ route: { meta: {} }, params: {}, data: undefined, error: null, children: [] }]
		};
		const state = {
			match: null,
			navigation: "idle",
			error: null,
			pathname: "/x",
			searchParams: new URLSearchParams()
		};
		const outlet = new Outlet({});
		outlet.context = {
			node: { route: { meta: {} }, params: {}, data: undefined, error: null, children: [child] },
			state
		};

		const tree = outlet.render();

		const leaf = tree.children[0];
		assert.equal(leaf.type, C);
		assert.equal(leaf.props.error, err);
		assert.equal(leaf.props.data, undefined);
		// children resolved independently — the component may still render an <Outlet>
		assert.equal(tree.props.value.node, child);
	});

	it("resubscribes when the router prop changes", async () => {
		const { Router } = await importPreactAdapter();
		const first = makeAdapterRouter("first");
		const second = makeAdapterRouter("second");
		const view = new Router({ router: first });

		view.componentDidMount();
		assert.equal(first.subscribed, 1);

		view.props = { router: second };
		view.componentDidUpdate?.({ router: first });

		assert.equal(first.unsubscribed, 1);
		assert.equal(second.subscribed, 1);

		second.emit();
		assert.equal(view.state.router, second.snapshot);
	});
});
