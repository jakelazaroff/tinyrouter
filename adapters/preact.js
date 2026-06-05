import { h, createContext, Component } from "preact";

/** @typedef {import("../tinyrouter.js").MatchNode} MatchNode */
/** @typedef {import("../tinyrouter.js").TinyRouter} TinyRouter */
/** @typedef {import("preact").ComponentChildren} ComponentChildren */

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

const MatchContext = /** @type {import("preact").Context<MatchNode | null>} */ (createContext(null));

export const RouterContext = /** @type {import("preact").Context<TinyRouter | null>} */ (createContext(null));

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
		this.unsub = this.props.router.subscribe(() => {
			this.setState({ router: this.props.router.getSnapshot() });
		});
	}

	/** @override */
	componentWillUnmount() {
		this.unsub?.();
	}

	render() {
		const { match, error } = this.state.router;
		if (error) return this.props.fallback?.(error) ?? h("p", null, "Something went wrong");
		if (!match) return null;
		const C = /** @type {import("preact").ComponentType<{ params: Record<string, string>; data: unknown }> | undefined} */ (
			match.route.meta["component"]
		);
		const inner = C
			? h(
					MatchContext.Provider,
					{ value: match },
					h(C, { params: match.params, data: match.loaderData })
				)
			: h(Outlet, { node: match });
		return h(RouterContext.Provider, { value: this.props.router }, inner);
	}
}

/** @extends {Component<OutletProps>} */
export class Outlet extends Component {
	render() {
		/** @type {MatchNode | null} */
		const node = this.props.node ?? /** @type {MatchNode | null} */ (this.context);
		if (!node || node.children.length === 0) return null;

		const child = node.children[0];
		const C = /** @type {import("preact").ComponentType<{ params: Record<string, string>; data: unknown }> | undefined} */ (
			child.route.meta["component"]
		);
		if (!C) return null;

		return h(
			MatchContext.Provider,
			{ value: child },
			h(C, { params: child.params, data: child.loaderData })
		);
	}
}

Outlet.contextType = MatchContext;
