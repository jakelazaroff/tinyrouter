import { h, createContext, Component } from "preact";

/** @typedef {import("../tinyrouter.js").MatchNode} MatchNode */
/** @typedef {import("../tinyrouter.js").TinyRouter} TinyRouter */

/** @type {import("preact").Context<MatchNode | null>} */
const MatchContext = createContext(null);

export class Router extends Component {
  constructor(props) {
    super(props);
    this.state = { router: props.router.getSnapshot() };
    this.unsub = null;
  }

  componentDidMount() {
    this.unsub = this.props.router.subscribe(() => {
      this.setState({ router: this.props.router.getSnapshot() });
    });
  }

  componentWillUnmount() {
    this.unsub?.();
  }

  render() {
    const { match, error } = this.state.router;
    if (error) return this.props.fallback?.(error) ?? h("p", null, "Something went wrong");
    if (!match) return null;
    const Component = match.route.meta.component;
    if (Component) {
      return h(
        MatchContext.Provider,
        { value: match },
        h(Component, { params: match.params, data: match.loaderData }),
      );
    }
    return h(Outlet, { node: match });
  }
}

export class Outlet extends Component {
  render() {
    const node = this.props.node ?? this.context;
    if (!node || node.children.length === 0) return null;

    const child = node.children[0];
    const Component = child.route.meta.component;

    return h(
      MatchContext.Provider,
      { value: child },
      h(Component, { params: child.params, data: child.loaderData }),
    );
  }
}

Outlet.contextType = MatchContext;
