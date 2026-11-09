import "./augmentations.js";

export type {
	AssetHelper,
	CspNonceHelper,
	CsrfFieldHelper,
	CsrfMetaHelper,
	HelperFn,
	THelper,
	UrlHelper,
} from "./helpers.js";
export {
	type InkerErrorCode,
	type InkerErrorContext,
	InkerRenderError,
} from "./InkerRenderError.js";
// The default export is the plugin registrar, the way `import edge from
// 'edge.js'` hands back the engine to push plugins into. Read `plugins.ts` for
// why it is a registrar here and not the engine itself.
export {
	default,
	type InkerSharedRenderer,
	plugins,
} from "./plugins.js";
export type {
	InkerTag,
	InkerTagBuffer,
	InkerTagParser,
	InkerTagToken,
} from "./renderNode.js";
export { SafeString } from "./SafeString.js";
// The stack store backing `@stack` / `@pushTo` / `@pushOnceTo`. Exported so a
// host can pre-seed a stack (or read one back) around a render, the way Edge
// exposes `template.stacks`.
export { Stacks } from "./stacks.js";
export {
	type InkerPluginFn,
	type InkerPluginOptions,
	type OutputProcessorValue,
	Processor,
	type RawProcessorValue,
	TemplateRenderer,
	Templates,
	type TemplatesOptions,
} from "./Templates.js";
