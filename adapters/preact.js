import { h, createContext, Component } from "preact";

/** @typedef {import("../tinyrouter.js").MatchNode} MatchNode */
/** @typedef {import("../tinyrouter.js").default} TinyRouter */
/** @typedef {import("preact").ComponentChildren} ComponentChildren */

/** @typedef {import("preact").ComponentType<{ params: Record<string, string>; data: unknown }>} RouteComponentType */

/**
 * @typedef {object} RouterProps
 * @property {TinyRouter} router
 * @property {(error: unknown) => ComponentChildren} [fallback]
 */

/**
 * @typedef {object} RouterState
 * @property {import("../tinyrouter.js").RouterState} router
 */

/**
 * @typedef {object} OutletProps
 * @property {MatchNode} [node]
 */

const MatchContext = /** @type {import("preact").Context<MatchNode | null>} */ (
	createContext(null)
);

export const RouterContext = /** @type {import("preact").Context<TinyRouter | null>} */ (
	createContext(null)
);

/**
 * Renders a match node's component, providing the node as context for nested <Outlet>s.
 * Component-less nodes (pass-through layouts) defer to their first child.
 *
 * @param {MatchNode | null | undefined} node
 * @returns {ComponentChildren}
 */
function renderMatch(node) {
	if (!node) return null;
	const C = /** @type {RouteComponentType | undefined} */ (
		/** @type {unknown} */ (node.route.meta.component)
	);
	if (!C) return renderMatch(node.children[0]);
	return h(
		MatchContext.Provider,
		{ value: node },
		h(C, { params: node.params, data: node.loaderData })
	);
}

/** @extends {Component<RouterProps, RouterState>} */
export class Router extends Component {
	/** @param {RouterProps} props */
	constructor(props) {
		super(props);
		this.state = { router: props.router.getSnapshot() };
		/** @type {(() => void) | null} */
		this.unsub = null;
	}

	/** @override */
	componentDidMount() {
		const update = () => this.setState({ router: this.props.router.getSnapshot() });
		this.unsub = this.props.router.subscribe(update);
		// A navigation may have completed between construction and mount; re-read
		// the snapshot so we don't render stale state until the next notify.
		update();
	}

	/** @override */
	componentWillUnmount() {
		this.unsub?.();
	}

	render() {
		const { match, error } = this.state.router;
		if (error) return this.props.fallback?.(error) ?? h("p", null, "Something went wrong");
		if (!match) return null;
		return h(RouterContext.Provider, { value: this.props.router }, renderMatch(match));
	}
}

/** @extends {Component<OutletProps>} */
export class Outlet extends Component {
	render() {
		const node = this.props.node ?? /** @type {MatchNode | null} */ (this.context);
		return renderMatch(node?.children[0]);
	}
}

Outlet.contextType = MatchContext;
