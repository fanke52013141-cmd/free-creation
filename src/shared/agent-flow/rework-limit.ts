import { z } from 'zod'

export const MAX_REWORKS = 3

export const ReworkLimitSchema = z.number().int().min(0).max(MAX_REWORKS).default(MAX_REWORKS)

/** Existing review cards used to accept up to ten attempts. */
export const SavedReviewReworkLimitSchema = z.number().int().min(0).max(10)
  .transform((limit) => Math.min(limit, MAX_REWORKS))
  .default(MAX_REWORKS)
