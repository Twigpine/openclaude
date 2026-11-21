; Adapted from Aider's tree-sitter language queries.
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
