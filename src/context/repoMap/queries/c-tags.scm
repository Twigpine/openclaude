; Adapted from Aider's tree-sitter language queries.
; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/c-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Definitions and references only: the repo map renders signature lines, so the
; leading-comment captures Aider uses for documentation are omitted here.

; A specifier with a body declares the type. A bodyless specifier is only a
; forward declaration, and one that appears inside a field or parameter is a
; reference to a type defined elsewhere, so neither is a definition here.
(struct_specifier
  name: (type_identifier) @name.definition.class
  body: (field_declaration_list)) @definition.class

(union_specifier
  name: (type_identifier) @name.definition.class
  body: (field_declaration_list)) @definition.class

(enum_specifier
  name: (type_identifier) @name.definition.enum
  body: (enumerator_list)) @definition.enum

; Typedef aliases (typedef struct {...} Point; typedef int len_t;). A named tag
; in the same typedef reports its own definition as well, so the alias and the
; tag can both appear for the same name.
(type_definition
  declarator: [
    (type_identifier) @name.definition.type
    (pointer_declarator
      declarator: (type_identifier) @name.definition.type)
  ]) @definition.type

; Definitions and declarations (prototypes in headers) share function_declarator.
; Matching the declarator rather than the enclosing statement keeps
; pointer-returning signatures such as char *dup(void) in scope, where the
; declarator sits under a pointer_declarator.
(function_declarator
  declarator: (identifier) @name.definition.function) @definition.function

(call_expression
  function: [
    (identifier) @name.reference.call
    (field_expression
      field: (field_identifier) @name.reference.call)
  ]) @reference.call

; Struct, union and enum tags, typedef names and parameter types are
; type_identifier nodes. Self-references are dropped when the graph is built.
(type_identifier) @name.reference.type
