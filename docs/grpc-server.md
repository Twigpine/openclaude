# Headless gRPC Server

OpenClaude can be run as a headless gRPC service, allowing you to integrate
its agentic capabilities (tools, bash, file editing) into other applications,
CI/CD pipelines, or custom user interfaces. The server uses bidirectional
streaming to send real-time text chunks, tool calls, and request permissions
for sensitive commands.

## 1. Start the gRPC server

Start the core engine as a gRPC service on `localhost:50051`:

```bash
npm run dev:grpc
```

### Configuration

| Variable | Default | Description |
|-----------|-------------|------------------------------------------------|
| `GRPC_PORT` | `50051` | Port the gRPC server listens on |
| `GRPC_HOST` | `127.0.0.1` | Bind address. Loopback by default. A non-loopback value (such as `0.0.0.0`) is **refused at startup unless `GRPC_AUTH_TOKEN` is set** |
| `GRPC_AUTH_TOKEN` | _(unset)_ | Bearer token required on every request. When set, clients must send `authorization: Bearer <token>` metadata |

### Authentication

The headless gRPC server exposes the full agent loop (Bash/Write/Edit/Read
plus tool approval), so it must not be reachable by unauthenticated clients.
It binds to `127.0.0.1` by default; to expose it on another interface you must
set `GRPC_AUTH_TOKEN`, and every request then needs the matching bearer token:

```bash
export GRPC_AUTH_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
GRPC_HOST=0.0.0.0 npm run dev:grpc
```

Requests without a valid `authorization: Bearer <token>` metadata header are
rejected with `UNAUTHENTICATED`. TLS is not terminated by the server itself;
run it behind a TLS-terminating proxy if it crosses a network boundary.

## 2. Run the test CLI client

A lightweight CLI client is provided that communicates exclusively over gRPC.
It acts just like the main interactive CLI, rendering colors, streaming
tokens, and prompting you for tool permissions (y/n) via the gRPC
`action_required` event.

In a separate terminal, run:

```bash
npm run dev:grpc:cli
```

> **Note:** The gRPC definitions are located in `src/proto/openclaude.proto`.
> You can use this file to generate clients in Python, Go, Rust, or any other
> language.
