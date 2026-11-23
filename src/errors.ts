/**
 * The errors inker raises outside a template: a call refused before any
 * template is read, a provider not started, a helper given a bad argument.
 * Edge throws plain `Error`s at these places; inker gives each a code, as every
 * ream package does. An error at a position in a template is an `InkerError`
 * instead (`inkerError.ts`), and a code such as `E_INKER_INVALID_PATH` comes
 * either way: test `error.code` to cover both.
 */

import { createError } from "@c9up/flare";

/** No template file has this name; the `ENOENT` is on `cause`. */
export const E_INKER_TEMPLATE_NOT_FOUND = createError<[string]>(
	"%s",
	"E_INKER_TEMPLATE_NOT_FOUND",
);

/**
 * A root, template name, disk name, helper, global, tag or plugin given to a
 * call cannot be used.
 */
export const E_INKER_INVALID_PATH = createError<[string]>(
	"%s",
	"E_INKER_INVALID_PATH",
);

/** `SafeString` was given a value that is not a string, or a stack was declared twice outside a template. */
export const E_INKER_INVALID_EXPRESSION = createError<[string]>(
	"%s",
	"E_INKER_INVALID_EXPRESSION",
);

/** Two disks are mounted under one name. */
export const E_INKER_DISK_COLLISION = createError<[string]>(
	"%s",
	"E_INKER_DISK_COLLISION",
);

/** `registerTemplate` was given a name another registration already holds. */
export const E_INKER_TEMPLATE_COLLISION = createError<[string]>(
	"%s",
	"E_INKER_TEMPLATE_COLLISION",
);

/** A getter or `toJSON` of the data given to `html.jsonLd` threw. */
export const E_INKER_HELPER_THROW = createError<[string]>(
	"%s",
	"E_INKER_HELPER_THROW",
);

/** `html.jsonLd` was given a value JSON cannot hold faithfully. */
export const E_INKER_INVALID_JSON_LD = createError<[string]>(
	"%s",
	"E_INKER_INVALID_JSON_LD",
);

/** The module singleton was asked to render before any `InkerProvider` built an engine. */
export const E_INKER_ENGINE_MISSING = createError<[string]>(
	"%s",
	"E_INKER_ENGINE_MISSING",
);

/** The native binary cannot be loaded. */
export const E_INKER_NAPI_REQUIRED = createError<[string]>(
	"%s",
	"E_INKER_NAPI_REQUIRED",
);

/** The renderer was used before `InkerProvider.start()` ran, or before `setInker()` seated one. */
export const E_INKER_NOT_BOOTED = createError<[string]>(
	"%s",
	"E_INKER_NOT_BOOTED",
);

/** `config.inker` holds a value the provider cannot use (`cacheMode`, `additionalHelpers`). */
export const E_INKER_INVALID_CONFIG = createError<[string]>(
	"%s",
	"E_INKER_INVALID_CONFIG",
);

/** A view helper (`t`, `url`, `route`, `signedRoute`, `config`, `formAttributes`, `asset`) was called with an argument it cannot use. */
export const E_INKER_INVALID_HELPER_ARGUMENT = createError<[string]>(
	"%s",
	"E_INKER_INVALID_HELPER_ARGUMENT",
);

/** A helper that reads the request was called outside `inker.render()`. */
export const E_INKER_OUTSIDE_RENDER = createError<[string]>(
	"%s",
	"E_INKER_OUTSIDE_RENDER",
);
