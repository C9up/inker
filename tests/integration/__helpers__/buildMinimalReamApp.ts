/**
 * Test-only helper that boots a minimal Ream container, registers Rosetta +
 * Router + InkerProvider, and hands back the wired pieces so each
 * integration test can exercise `inker.render` against fixture templates.
 *
 * NOT shipped in `dist/` — `tsconfig.build.json` excludes the `tests/` tree.
 */

import { fileURLToPath } from "node:url";
import { Container, Router, SimpleConfigStore } from "@c9up/ream";
import { _setRouter } from "@c9up/ream/services/router";
import { Rosetta } from "@c9up/rosetta";
import InkerProvider, {
	_resetInkerProviderFlags,
	type InkerProviderConfig,
} from "../../../src/InkerProvider.js";
import type { InkerHttpContext } from "../../../src/InkerRenderer.js";
import { InkerRenderer } from "../../../src/InkerRenderer.js";
import { _setInker } from "../../../src/services/main.js";
import { bypassTypeCheck } from "../../__helpers__/bypass-type-check.js";

export interface BuildAppOptions {
	/** Absolute path to the fixture project root. */
	appRoot: string;
	/** Optional inker config — defaults to nothing (use fixture defaults). */
	inkerConfig?: InkerProviderConfig;
	/** Optional preset of Rosetta message catalogs. */
	messages?: Record<string, Record<string, string>>;
}

export interface BuiltApp {
	inker: InkerRenderer;
	rosetta: Rosetta;
	router: Router;
	makeCtx(overrides?: Partial<InkerHttpContext>): TrackedCtx;
}

export interface TrackedCtx extends InkerHttpContext {
	readonly typeCalls: string[];
	readonly sendCalls: string[];
}

export async function buildMinimalReamApp(
	opts: BuildAppOptions,
): Promise<BuiltApp> {
	_resetInkerProviderFlags();
	// Clear the module-scoped singleton so subsequent tests can't observe a
	// previous app's renderer via `services/main`. The `bypassTypeCheck`
	// route satisfies `feedback_no_any_types` (one sanctioned cast site for
	// inker test code).
	_setInker(bypassTypeCheck<InkerRenderer>(undefined));

	const container = new Container();
	const config = new SimpleConfigStore();

	if (opts.inkerConfig !== undefined) {
		config.set("inker", opts.inkerConfig);
	}

	const router = new Router();
	_setRouter(router);

	const rosetta = new Rosetta({
		defaultLocale: "en",
		messages: opts.messages ?? {
			en: { greeting: "Hello, {name}!" },
			fr: { greeting: "Bonjour, {name} !" },
		},
	});

	container.bindValue("appRoot", opts.appRoot);
	container.bindValue("rosetta", rosetta);

	const provider = new InkerProvider({ container, config });
	provider.register();
	await provider.start();

	const inker = container.resolve<InkerRenderer>(InkerRenderer);

	return {
		inker,
		rosetta,
		router,
		makeCtx(overrides: Partial<InkerHttpContext> = {}): TrackedCtx {
			const typeCalls: string[] = [];
			const sendCalls: string[] = [];
			return {
				request: {},
				response: {
					type(value: string) {
						typeCalls.push(value);
						return undefined;
					},
					send(body: string) {
						sendCalls.push(body);
						return undefined;
					},
				},
				store: new Map(),
				locale: "en",
				typeCalls,
				sendCalls,
				...overrides,
			};
		},
	};
}

export function fixtureRoot(metaUrl: string, relative: string): string {
	return fileURLToPath(new URL(relative, metaUrl));
}
