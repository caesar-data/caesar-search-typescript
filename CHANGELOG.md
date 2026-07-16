# Changelog

## 0.4.0

- Breaking: removed `usage.approx_tokens` from search/document/feedback responses (server no longer returns it). `usage` now contains only `requests` and `bytes_returned`.

## 0.2.0

- The public Caesar API now requires an API key. Clients without a key now raise `missing_api_key` locally instead of sending an anonymous request.
- Refreshed the vendored OpenAPI spec from the required-auth public contract.

Releases are documented on the [GitHub releases page](https://github.com/caesar-data/caesar-search-typescript/releases).
