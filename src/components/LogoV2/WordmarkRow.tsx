import * as React from 'react'
import { Text } from '../../ink.js'
import {
  WORDMARK_ACCENT_LEFT,
  WORDMARK_ACCENT_RIGHT,
  WORDMARK_CLAUDE,
  WORDMARK_OPEN,
} from '../../constants/brand.js'

/**
 * The single-row brand wordmark: shade-gradient accents flanking letter-spaced
 * caps, with the OPEN half (and left accent) in the shimmer accent and the
 * CLAUDE half (and right accent) in the brand accent.
 */
export function WordmarkRow(): React.ReactElement {
  return (
    <Text>
      <Text color="brandShimmer">{WORDMARK_ACCENT_LEFT} </Text>
      <Text bold={true} color="brandShimmer">
        {WORDMARK_OPEN}
      </Text>
      <Text bold={true} color="brand">
        {' '}
        {WORDMARK_CLAUDE}
      </Text>
      <Text color="brand"> {WORDMARK_ACCENT_RIGHT}</Text>
    </Text>
  )
}
