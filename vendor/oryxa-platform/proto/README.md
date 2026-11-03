# Vendored protobuf definitions

| Path | Source | Licence |
| --- | --- | --- |
| `authzed/` | github.com/authzed/api @ v1.57.0 (SpiceDB API) | Apache-2.0 (`authzed/LICENSE`) |
| `google/api`, `google/rpc` | github.com/googleapis/googleapis | Apache-2.0 |
| `buf/validate` | github.com/bufbuild/protovalidate | Apache-2.0 |
| `validate/` | github.com/bufbuild/protoc-gen-validate | Apache-2.0 |
| `protoc-gen-openapiv2/` | github.com/grpc-ecosystem/grpc-gateway | BSD-3-Clause |
| `oryxa/` | ours: the event contract (`events/`) and the connector contract (`connector/`) | — |

Compiled with protox at build time (`crates/oryxa-spicedb-proto`, `crates/oryxa-events`,
`crates/oryxa-connector`); no protoc needed.
