# Schema validation

Use Zod 4 through `zod/v4`. The root development dependency and root and website
resolution overrides pin the package to exactly `4.6.7`. Regenerate both lockfiles
with Bun after changing the pin.

Use `z.strictObject` when unknown keys must fail, `z.looseObject` when they must
survive, and `z.object` when unknown keys should be stripped. Records require
explicit key and value schemas, for example `z.record(z.string(), z.unknown())`.
Prefer top-level format schemas such as `z.email`, `z.url`, and `z.iso.datetime`.
Use `.check` to apply a format schema after existing length checks. Customize
messages with the `error` option and read validation failures from `.issues`.

A default short-circuits parsing and must match the output type. Use `.prefault`
when a fallback must pass through preprocessing or transforms. Defaults inside
optional object fields are still applied. Preserve these choices when editing
schemas, especially around numeric and boolean input preprocessing.

Generate API schemas through the shared `zodToJsonSchema` helper. It retains
native conversion, caches by schema identity, and preserves the established
`anyOf` representation for primitive and discriminated unions. This keeps the
published JSON documents stable across the package upgrade. It visits schema
keywords only, leaving defaults and other user data intact.

The schema compatibility tests capture fingerprints of complete generated and
advertised JSON documents for every exported input and output schema. They run
the enumeration in a fresh process to avoid shared mocks hiding schemas. These
snapshots were captured before the dependency upgrade; do not regenerate them
to hide unintended changes. The fixture's `--full` option prints the documents
for investigating a changed fingerprint.

The sandbox dependency still uses `zod/v3`. The exact root override resolves it
to the v3 compatibility export shipped in the pinned v4 package; the dependency
is unmodified. Dependency compatibility tests exercise that configuration
parser, both protocol conversion branches, and structured-output parsing.

Zod is bundled into the distributed JavaScript. The published SDK declarations
do not refer to it, and it is not exposed as a peer dependency. If that type
contract changes, declare a compatible peer range and document the SDK breaking
change before publishing.
