import { h, createContext, Component } from "preact";

/** @typedef {import("../tinyrouter.js").MatchNode} MatchNode */
/** @typedef {import("../tinyrouter.js").default} TinyRouter */
/** @typedef {import("preact").ComponentChildren} ComponentChildren */

/** @typedef {import("../tinyrouter.js").RouterState} TinyRouterState */
/**
 * @typedef {import("preact").ComponentType<{
 * 	params: Record<string, string>;
 * 	data: unknown;
 * 	pathname: string;
 * 	searchParams: URLSearchParams;
 * 	navigation: "idle" | "loading";
 * 	error: unknown;
 * }>} RouteComponentType
 */

/**
 * @typedef {object} RouterProps
 * @property {TinyRouter} router
 * @property {(error: unknown) => ComponentChildren} [fallback]
 */

/**
 * @typedef {object} RouterState
 * @property {import("../tinyrouter.js").RouterState} router
 */

const MatchContext =
	/** @type {import("preact").Context<{ node: MatchNode; state: TinyRouterState } | null>} */ (
		createContext(null)
	);

export const RouterContext = /** @type {import("preact").Context<TinyRouter | null>} */ (
	createContext(null)
);

/**
 * @param {MatchNode | null | undefined} node
 * @param {TinyRouterState} state
 * @returns {ComponentChildren}
 */
function renderMatch(node, state) {
	if (!node) return null;
	const C = /** @type {RouteComponentType | undefined} */ (/** @type {unknown} */ (node.component));
	if (!C) return renderMatch(node.children[0], state);
	return h(
		MatchContext.Provider,
		{ value: { node, state } },
		h(C, {
			params: node.params,
			data: node.data,
			pathname: state.pathname,
			searchParams: state.searchParams,
			navigation: state.navigation,
			error: node.error ?? null
		})
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

	#subscribe() {
		this.unsub?.();
		const update = () => this.setState({ router: this.props.router.getSnapshot() });
		this.unsub = this.props.router.subscribe(update);
		// A navigation may have completed before subscription; re-read the snapshot
		// so we don't render stale state until the next notify.
		update();
	}

	/** @override */
	componentDidMount() {
		this.#subscribe();
	}

	/** @param {RouterProps} prevProps @override */
	componentDidUpdate(prevProps) {
		if (prevProps.router !== this.props.router) this.#subscribe();
	}

	/** @override */
	componentWillUnmount() {
		this.unsub?.();
		this.unsub = null;
	}

	render() {
		const { match, error } = this.state.router;
		if (error) return this.props.fallback?.(error) ?? h("p", null, "Something went wrong");
		if (!match) return null;
		return h(
			RouterContext.Provider,
			{ value: this.props.router },
			renderMatch(match, this.state.router)
		);
	}
}

export class Outlet extends Component {
	/** @override */
	static contextType = MatchContext;

	render() {
		const { node, state } = this.context;
		return renderMatch(node.children[0], state);
	}
}
