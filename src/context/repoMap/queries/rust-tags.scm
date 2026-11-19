; Adapted from Aider's tree-sitter language queries.
; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/rust-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Definitions and references only: the repo map renders signature lines, so the
; leading-comment captures Aider uses for documentation are omitted here.

(function_item
  name: (identifier) @name.definition.function) @definition.function

(struct_item
  name: (type_identifier) @name.definition.class) @definition.class

(enum_item
  name: (type_identifier) @name.definition.enum) @definition.enum

(trait_item
  name: (type_identifier) @name.definition.interface) @definition.interface

(mod_item
  name: (identifier) @name.definition.module) @definition.module

(impl_item
  type: (type_identifier) @name.reference.class) @reference.class

(call_expression
  function: [
    (identifier) @name.reference.call
    (field_expression
      field: (field_identifier) @name.reference.call)
    (scoped_identifier
      name: (identifier) @name.reference.call)
  ]) @reference.call
