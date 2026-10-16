# Isolated subscription worker

The supervisor runs one pinned Claude Code process per materialized pass. Only the supervisor can obtain the subscription OAuth credential or control Docker. The worker receives the credential in its environment and inert source files through one read-only mount. It has no GitHub client, publication method, cloud credentials or container socket.

Docker container configuration never receives the credential. The supervisor sends a bounded credential line followed by the review request over attached stdin. The trusted image bootstrap consumes exactly that line, then replaces itself with the unmodified pinned CLI and sets the credential only in the new process environment. The remaining stdin reaches the CLI unchanged. Tokens must be 1 through 8192 visible ASCII bytes without whitespace. Malformed framing fails closed with a fixed diagnostic. The bootstrap is verified against the trusted file at startup and included in runtime identity.

## Caller contract

Build the two images from `worker/Dockerfile` and `worker/proxy.Dockerfile`. Configure their immutable local `sha256:` image IDs, never tags. Keep the trusted `worker/` files beside `dist/` in the service artifact. `createWorker({ workerImage, proxyImage, temporaryRoot, oauthToken })` verifies Linux amd64, Docker 28 or newer, CLI/Node/Squid versions and embedded settings, prompt and proxy configuration. Image provenance remains the operator's responsibility. Version/config checks do not make an arbitrary supplied image trustworthy.

The factory returns `{ runtimeHash, runPass, reap }`. Use this runtime hash before admitting identities or capturing source. It binds both images, CLI/model versions, flags, sandbox arguments, supervisor module and profile files. Per-pass CA randomness is excluded. Changing source or compiled execution mode changes the hash, so use one built service artifact consistently.

Acquire exclusive service ownership, then await `reap()` before admitting or resuming work. It removes containers and networks carrying the exact `io.basic-pr-reviewer.owner=worker-service` label, then removes its `worker-XXXXXX` temporary directories. The temporary root and label belong exclusively to one service on that Docker daemon. Never run the reaper while another instance is active. A failed reap blocks startup. The worker also refuses passes until recovery succeeds and after any failed cleanup. The scheduler must stop admission on `cleanup_failure` and recover under exclusive ownership. A lease timeout alone does not prove an old container stopped.

Call `runPass(identity, spec, signal)` only with `spec` returned by verified `source.materializePass`. Its runtime-only fields are `bundlePath`, assigned `reviewUnits`, descriptor `sourceMap`, and captured `trustedInstructions`. The bundle directory equals the sole allowed read scope. The worker checks exact inert aliases, file hashes, initial-input size and instruction hashes before mounting. The source owner must keep those files immutable until the worker exits, then destroy the bundle and capture workspace in its own `finally`. The worker removes its containers, networks, temporary home and public-CA directory. Store strips all runtime-only fields before persisting a pass.

Only exit-zero structured output can complete a pass. Trusted code checks the schema, model identity, assigned evidence, prior-finding membership and path/side/line ranges, then assigns finding IDs. Assistant fallback text never grants coverage. Failed outcomes contain safe codes and no raw stdout/stderr; their model field identifies the requested profile, not observed inference. The scheduler decides coverage and retry policy from these outcomes.

## Container and network boundary

Workers use UID/GID 1000, a read-only root and source, dropped capabilities, no-new-privileges, bounded memory/PIDs/CPU and an ephemeral noexec home. The Linux supervisor must also run as UID 1000; the factory rejects a mismatch. Source retains owner-only 0500 directories and 0400 files. The dedicated host must provide that service identity without widening source permissions. The trusted empty working directory prevents source autoload. Read, Glob and Grep are the only file tools. StructuredOutput is the CLI's output-only schema transport. Tool search, Claude-hosted MCP, other MCP, customization discovery and hooks are disabled.

Each worker joins only an internal Docker bridge with `gateway_mode_ipv4=isolated` and IPv6 disabled. Ordinary internal bridges retain host gateway access and are insufficient. A dedicated Squid proxy joins that bridge and a separate egress bridge. No ports are published. DNS resolution is provided by Docker; application traffic must use the proxy.

The proxy permits only `api.anthropic.com:443`, POST `/v1/messages` and POST `/v1/messages/count_tokens`, with no query or exactly `?beta=true`. Other hosts, methods, paths and queries fail closed. Destination ACLs deny nonglobal IPv4 and all IPv6, including provider names resolving to private addresses. Numeric CONNECT hosts and deceptive suffixes are denied. Upstream certificates must validate.

Squid decrypts provider HTTPS inside this dedicated trusted proxy. A CONNECT-only allowlist cannot stop remotely managed settings that can override local hook restrictions in noninteractive Claude Code. TLS bump prevents policy, configuration, OAuth mutation and account-administration requests before their bodies reach the provider. Each pass creates a one-day CA whose private key stays in proxy tmpfs. Only its public certificate is mounted in the worker. Docker and Squid traffic logs are disabled; no headers, bodies or credentials are retained. The supervisor and Docker daemon remain trusted with the OAuth credential.

## Local acceptance and live gate

Run these commands from the repository root on an idle development Docker daemon:

```sh
docker build -f worker/Dockerfile -t basic-pr-reviewer-worker:task5 .
docker build -f worker/proxy.Dockerfile -t basic-pr-reviewer-proxy:task5 .
npm run build
node scripts/acceptance.ts --worker-profile
```

Acceptance uses synthetic credentials and a fixture-only HTTPS origin. It checks actual pinned CLI tools, blocked source hooks/MCP, outside-bundle reads, exact proxy routes, upstream certificate rejection, private DNS, direct host/private/metadata/public access, cancellation, orphan recovery and cleanup. It inspects Docker metadata without printing it and proves the credential and OAuth environment entry are absent while CLI authentication succeeds. The provider also checks that the credential is absent from model input. Its records contain assertions and tool names, never request bodies. Unit tests cover output validation, process limits, large stdin, credential framing, cleanup-failure recovery and metadata nonpersistence.

These checks do not establish subscription entitlement, successful real inference, or production-host networking. The separately authorized hosted pilot must verify the exact image IDs and runtime hash, real subscription authentication and model identity, effective tool/policy behavior, inference-path compatibility and network denials on that host. An unexpected startup endpoint or tool blocks launch. Do not broaden paths, enable remote policy or add API-key fallback to make authentication work. No automatic token refresh or account mutation is supported.

Official references: [CLI flags](https://code.claude.com/docs/en/cli-reference), [managed settings](https://code.claude.com/docs/en/server-managed-settings), [proxy and custom CA support](https://code.claude.com/docs/en/network-config), [Docker isolated gateways](https://docs.docker.com/engine/network/port-publishing/), [Squid ACLs](https://www.squid-cache.org/Doc/config/acl/), [TLS bump](https://www.squid-cache.org/Doc/config/ssl_bump/).
