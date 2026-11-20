; Adapted from Aider's tree-sitter language queries.
; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/cpp-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Definitions and references only: the repo map renders signature lines, so the
; leading-comment captures Aider uses for documentation are omitted here.
;
; The C++ grammar is a superset of C, so .h files are parsed with it and the C
; shapes (structs, unions, enums, typedefs, prototypes) are captured here too.

; A specifier with a body declares the type. A bodyless specifier is only a
; forward declaration, and one that appears inside a field or parameter is a
; reference to a type defined elsewhere, so neither is a definition here.
(class_specifier
  name: (type_identifier) @name.definition.class
  body: (field_declaration_list)) @definition.class

(struct_specifier
  name: (type_identifier) @name.definition.class
  body: (field_declaration_list)) @definition.class

(union_specifier
  name: (type_identifier) @name.definition.class
  body: (field_declaration_list)) @definition.class

(enum_specifier
  name: (type_identifier) @name.definition.enum
  body: (enumerator_list)) @definition.enum

(namespace_definition
  name: (namespace_identifier) @name.definition.module) @definition.module

; using X = Y; aliases, plus the C typedef shapes.
(alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(type_definition
  declarator: [
    (type_identifier) @name.definition.type
    (pointer_declarator
      declarator: (type_identifier) @name.definition.type)
  ]) @definition.type

; One pattern for every function shape: free functions and prototypes
; (identifier), in-class declarations (field_identifier), and out-of-class
; definitions, constructors, destructors and operators, which wrap the name in
; a qualified_identifier. Matching the declarator keeps pointer- and
; reference-returning signatures in scope, where it sits under a
; pointer_declarator or reference_declarator.
(function_declarator
  declarator: [
    (identifier) @name.definition.function
    (field_identifier) @name.definition.method
    (qualified_identifier
      name: (identifier) @name.definition.method)
    (qualified_identifier
      name: (destructor_name) @name.definition.method)
    (qualified_identifier
      name: (operator_name) @name.definition.method)
    (destructor_name) @name.definition.method
    (operator_name) @name.definition.function
  ]) @definition.function

(call_expression
  function: [
    (identifier) @name.reference.call
    (field_expression
      field: (field_identifier) @name.reference.call)
    (qualified_identifier
      name: (identifier) @name.reference.call)
  ]) @reference.call

; Class, struct, enum, typedef and template-argument types are type_identifier
; nodes. Self-references are dropped when the graph is built.
(type_identifier) @name.reference.type
