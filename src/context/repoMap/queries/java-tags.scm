; Adapted from Aider's tree-sitter language queries.
; Source: https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-languages/java-tags.scm
; License: MIT (Apache-2.0 dual) — see https://github.com/Aider-AI/aider/blob/main/LICENSE
; Definitions and references only: the repo map renders signature lines, so the
; leading-comment captures Aider uses for documentation are omitted here.

(class_declaration
  name: (identifier) @name.definition.class) @definition.class

(record_declaration
  name: (identifier) @name.definition.class) @definition.class

(interface_declaration
  name: (identifier) @name.definition.interface) @definition.interface

(annotation_type_declaration
  name: (identifier) @name.definition.interface) @definition.interface

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

(method_declaration
  name: (identifier) @name.definition.method) @definition.method

(constructor_declaration
  name: (identifier) @name.definition.method) @definition.method

; Annotation elements (String value(); inside an @interface) are method-shaped
; declarations that method_declaration does not match.
(annotation_type_element_declaration
  name: (identifier) @name.definition.method) @definition.method

; Every dotted call (obj.method(), Type.static(), a.b().c()) names its callee in
; the invocation's name field, so one pattern covers instance and static calls.
(method_invocation
  name: (identifier) @name.reference.call) @reference.call

; Method references (this::normalize, Type::of) carry no name field.
(method_reference
  (identifier) @name.reference.call) @reference.call

; Type positions — field, parameter, return, extends/implements, generic
; arguments and constructor calls — are all type_identifier nodes, so a single
; pattern covers them without emitting duplicate captures for new expressions.
(type_identifier) @name.reference.type
