import {
    WP_REST_API_USE_GLOBAL_METHOD,
    RouteRequestInterface,
    RouteParamsInterface,
    RouteResponseInterface,
    RequestArgs,
    commonUrlBuilder,
    RouteHttpVerb
} from "./";
import deepMerge from "deepmerge";
import Url from "url-parse";
import "whatwg-fetch"; // window.fetch polyfill

/**
 * Build and execute a specific REST query.
 *
 * @see urlBuilder
 * @returns Result of REST API
 * @throws
 */
async function commonRequest<
    TRequest extends RouteRequestInterface,
    TParams extends RouteParamsInterface,
    TResponse extends RouteResponseInterface
>({
    location,
    options,
    request: routeRequest,
    params,
    settings = {}
}: {
    request?: TRequest;
    params?: TParams;
    settings?: Partial<{ -readonly [P in keyof Request]: Request[P] }>;
} & RequestArgs): Promise<TResponse> {
    const url = commonUrlBuilder({ location, params, nonce: false, options });

    // Use global parameter (see https://developer.wordpress.org/rest-api/using-the-rest-api/global-parameters/)
    if (WP_REST_API_USE_GLOBAL_METHOD && location.method && location.method !== RouteHttpVerb.GET) {
        settings.method = "POST";
    } else {
        settings.method = "GET";
    }

    // Request with GET/HEAD method cannot have body
    const apiUrl = new Url(url, true);
    const allowBody = ["HEAD", "GET"].indexOf(settings.method) === -1;
    if (!allowBody && routeRequest) {
        apiUrl.set("query", deepMerge(apiUrl.query, routeRequest));
    }

    const result = await window.fetch(
        apiUrl.toString(),
        deepMerge.all([
            settings,
            {
                headers: {
                    "Content-Type": "application/json;charset=utf-8",
                    "X-WP-Nonce": options.restNonce
                },
                body: allowBody ? JSON.stringify(routeRequest) : undefined
            }
        ])
    );

    // `window.fetch` does not throw an error if the server response an error code.
    if (!result.ok) {
        let responseJSON = undefined;
        try {
            responseJSON = await result.json();
        } catch (e) {
            // Silence is golden.
        }

        const resultAny = result as any;
        resultAny.responseJSON = responseJSON;
        throw resultAny;
    }

    return (await result.json()) as TResponse;
}

export { commonRequest };
