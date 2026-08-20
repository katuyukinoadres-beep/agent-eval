/**
 * Emits a named fixture payload.
 *
 * Imports nothing from ../collect. That direction is enforced by a test rather
 * than left to discipline, because the moment fixtures can be produced by
 * scanning a real machine, "scan mine and edit a field" becomes the shortest way
 * to make one — and the conversation text, project paths and machine identifiers
 * in that scan end up committed as test data. Fixtures are written by hand, from
 * constants, and stay that way.
 */

import { BASE_PAYLOAD } from './base.js'
import type { Payload } from './types.js'

export const FIXTURES = { base: BASE_PAYLOAD } as const

export type FixtureName = keyof typeof FIXTURES

export function isFixtureName(s: string): s is FixtureName {
  return Object.hasOwn(FIXTURES, s)
}

export function fixture(name: FixtureName): Payload {
  return FIXTURES[name]
}

export function emit(name: FixtureName): string {
  return JSON.stringify(fixture(name), null, 2)
}

export const FIXTURE_NAMES: readonly FixtureName[] = Object.keys(FIXTURES) as FixtureName[]
