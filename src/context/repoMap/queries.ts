/**
 * Bundled tree-sitter tag queries.
 *
 * The .scm files in ./queries/ are the canonical source-of-truth (kept for
 * readability and Aider attribution), but the runtime reads from these inlined
 * string constants so the queries are bundled into dist/cli.mjs and ship with
 * the published npm package — the .scm files themselves are not in the
 * package.json `files` allowlist and would otherwise be missing post-install.
 *
 * If you edit a .scm file, mirror the change here. A unit test guards drift.
 */

import type { SupportedLanguage } from './types.js'

const TYPESCRIPT_TAGS = `; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/typescript-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Copied for use in openclaude's repo-map feature.

(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_annotation
  (type_identifier) @name.reference.type) @reference.type

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)]) @definition.function)

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)]) @definition.function)

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; Call references. The repo map ranks a file by references to symbols it
; defines, and plain function calls are its strongest structural signal:
; without these the TypeScript query only captured type annotations and
; constructor calls, which skewed the ranking toward type-heavy hub files.
; require(...) is excluded to match the JavaScript query, and member calls
; (object.method()) are deliberately not captured — method names such as
; .log(), .get() or .map() collide across unrelated classes and would add
; mostly-noise edges.
(
  (call_expression
    function: (identifier) @name.reference.call) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)
`

const JAVASCRIPT_TAGS = `; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/javascript-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Copied for use in openclaude's repo-map feature.

(
  (comment)* @doc
  .
  (method_definition
    name: (property_identifier) @name.definition.method) @definition.method
  (#not-eq? @name.definition.method "constructor")
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  [
    (class
      name: (_) @name.definition.class)
    (class_declaration
      name: (_) @name.definition.class)
  ] @definition.class
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  [
    (function_declaration
      name: (identifier) @name.definition.function)
    (generator_function_declaration
      name: (identifier) @name.definition.function)
  ] @definition.function
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name.definition.function
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (variable_declaration
    (variable_declarator
      name: (identifier) @name.definition.function
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\\\s\\\\*/]+|^[\\\\s\\\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(assignment_expression
  left: [
    (identifier) @name.definition.function
    (member_expression
      property: (property_identifier) @name.definition.function)
  ]
  right: [(arrow_function) (function_expression)]
) @definition.function

(pair
  key: (property_identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

(
  (call_expression
    function: (identifier) @name.reference.call) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)
  arguments: (_) @reference.call)

(new_expression
  constructor: (_) @name.reference.class) @reference.class
`

const PYTHON_TAGS = `; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/python-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Copied for use in openclaude's repo-map feature.

(class_definition
  name: (identifier) @name.definition.class) @definition.class

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(call
  function: [
      (identifier) @name.reference.call
      (attribute
        attribute: (identifier) @name.reference.call)
  ]) @reference.call
`

const GO_TAGS = `; Adapted from Aider's tree-sitter language queries.
; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/go-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Definitions and references only: the repo map renders signature lines, so the
; leading-comment captures Aider uses for documentation are omitted here.

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_declaration
  name: (field_identifier) @name.definition.method) @definition.method

(type_declaration
  [
    (type_spec
      name: (type_identifier) @name.definition.type)
    (type_alias
      name: (type_identifier) @name.definition.type)
  ]) @definition.type

(call_expression
  function: [
    (identifier) @name.reference.call
    (selector_expression
      field: (field_identifier) @name.reference.call)
  ]) @reference.call
`

const RUST_TAGS = `; Adapted from Aider's tree-sitter language queries.
; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/rust-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Definitions and references only: the repo map renders signature lines, so the
; leading-comment captures Aider uses for documentation are omitted here.

(function_item
  name: (identifier) @name.definition.function) @definition.function

; Bodyless trait methods, e.g. fn handle(&self); in a trait, parse as
; function_signature_item rather than function_item, so they need their own
; definition capture.
(function_signature_item
  name: (identifier) @name.definition.method) @definition.method

(struct_item
  name: (type_identifier) @name.definition.class) @definition.class

(enum_item
  name: (type_identifier) @name.definition.enum) @definition.enum

(trait_item
  name: (type_identifier) @name.definition.interface) @definition.interface

(mod_item
  name: (identifier) @name.definition.module) @definition.module

; A generic impl such as impl<T> Store<T> carries a generic_type node instead of
; a bare type_identifier, so the base type name is captured from both shapes.
(impl_item
  type: [
    (type_identifier) @name.reference.class
    (generic_type
      type: (type_identifier) @name.reference.class)
  ]) @reference.class

; Calls with explicit type arguments (helper::<u8>(), value.get::<u8>(),
; Type::<u8>::new()) wrap the callee in generic_function, which none of the plain
; alternatives match.
(call_expression
  function: [
    (identifier) @name.reference.call
    (field_expression
      field: (field_identifier) @name.reference.call)
    (scoped_identifier
      name: (identifier) @name.reference.call)
    (generic_function
      function: [
        (identifier) @name.reference.call
        (field_expression
          field: (field_identifier) @name.reference.call)
        (scoped_identifier
          name: (identifier) @name.reference.call)
      ])
  ]) @reference.call
`

const QUERIES: Record<SupportedLanguage, string> = {
  typescript: TYPESCRIPT_TAGS,
  tsx: TYPESCRIPT_TAGS,
  javascript: JAVASCRIPT_TAGS,
  python: PYTHON_TAGS,
  go: GO_TAGS,
  rust: RUST_TAGS,
}

export function getBundledQuery(language: SupportedLanguage): string | null {
  return QUERIES[language] ?? null
}
