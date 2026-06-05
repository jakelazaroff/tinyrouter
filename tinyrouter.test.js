import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { layout, route, index, lazy, TinyRouter } from "./tinyrouter.js";

// --- helpers ---

function mockWindow(pathname = "/") {
	globalThis.window = {
		location: { pathname, search: "" },
		addEventListener: () => {},
		history: { pushState() {}, replaceState() {} }
	};
	delete globalThis.navigation;
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
	mockWindow(pathname);
	const router = new TinyRouter(root, options);
	await waitIdle(router);
	return router;
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

	it("matches nested routes and accumulates params", async () => {
		const root = layout({}, [route("users", {}, [route(":id", {}, [index({})])])]);
		const router = await makeRouter(root, "/users/7");
		const idMatch = router.getSnapshot().match?.children[0].children[0];
		assert.equal(idMatch?.params.id, "7");
	});

	it("tries children in order and stops at first match", async () => {
		const root = layout({}, [route("a", {}, [index({})]), route("b", {}, [index({})])]);
		const router = await makeRouter(root, "/b");
		assert.equal(router.getSnapshot().match?.children[0].route.path, "b");
	});
});

describe("loaders", () => {
	it("runs the loader and stores data on the match node", async () => {
		const root = layout({}, [index({ loader: async () => ({ value: 42 }) })]);
		const router = await makeRouter(root, "/");
		assert.deepEqual(router.getSnapshot().match?.children[0].loaderData, { value: 42 });
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

	it("caches loader results when route and params are unchanged", async () => {
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

		// Navigating back hits the cache — loader should not run again.
		router.push("/about");
		await waitIdle(router);
		assert.equal(callCount, 1);
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

describe("lazy", () => {
	it("resolves the component before the route becomes active", async () => {
		const Comp = () => null;
		const root = layout({}, [index({ component: lazy(async () => Comp) })]);
		const router = await makeRouter(root, "/");
		const indexMatch = router.getSnapshot().match?.children[0];
		assert.equal(indexMatch?.route.meta["component"], Comp);
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

	it("navigating to an unmatched path yields null match", async () => {
		const root = layout({}, [index({})]);
		const router = await makeRouter(root, "/");
		router.push("/gone");
		await waitIdle(router);
		assert.equal(router.getSnapshot().match, null);
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

	it("warms the cache so a subsequent navigation skips the loader", async () => {
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

		assert.equal(callCount, 1);
	});
});
