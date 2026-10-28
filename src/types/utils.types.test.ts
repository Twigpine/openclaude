import type { DeepImmutable } from './utils.js'

type Assert<T extends true> = T
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false

type ImmutableReadonlyMap = DeepImmutable<
  ReadonlyMap<string, { items: string[] }>
>
type ImmutableReadonlyMapValue = NonNullable<
  ReturnType<ImmutableReadonlyMap['get']>
>
type _ReadonlyMapValueIsDeepImmutable = Assert<
  IsEqual<ImmutableReadonlyMapValue, { readonly items: readonly string[] }>
>

type ImmutableReadonlySet = DeepImmutable<ReadonlySet<{ items: string[] }>>
type ImmutableReadonlySetValue =
  ImmutableReadonlySet extends ReadonlySet<infer Value> ? Value : never
type _ReadonlySetValueIsDeepImmutable = Assert<
  IsEqual<ImmutableReadonlySetValue, { readonly items: readonly string[] }>
>

type ImmutableReadonlyTuple = DeepImmutable<
  readonly [{ a: string[] }, { b: number[] }]
>
type _ReadonlyTuplePreservesPositions = Assert<
  IsEqual<
    ImmutableReadonlyTuple,
    readonly [
      { readonly a: readonly string[] },
      { readonly b: readonly number[] },
    ]
  >
>

function assertReadonlyCollectionTypes(
  readonlyMap: ImmutableReadonlyMap,
  readonlySet: ImmutableReadonlySet,
  readonlyTuple: ImmutableReadonlyTuple,
): void {
  const mapValue = readonlyMap.get('test')
  if (mapValue) {
    // @ts-expect-error DeepImmutable keeps ReadonlyMap APIs but freezes nested values.
    mapValue.items.push('mutates')
  }

  for (const setValue of readonlySet) {
    // @ts-expect-error DeepImmutable keeps ReadonlySet APIs but freezes nested values.
    setValue.items.push('mutates')
  }

  // @ts-expect-error DeepImmutable preserves tuple positions and freezes nested values.
  readonlyTuple[0].a.push('mutates')

  // @ts-expect-error DeepImmutable preserves readonly tuple arity.
  void readonlyTuple[2]
}

void assertReadonlyCollectionTypes
