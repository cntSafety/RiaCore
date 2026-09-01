/*
 * Copyright (c) Samir Sarkic and Simon Roth
 *
 * This file is part of RiaCore.
 *
 * RiaCore is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
/**
 * DTOs for the concept presentation catalog (spec-view.md Phase 4.1).
 *
 * Presentation metadata is stored **outside** the view and outside the
 * `CommonModel` metamodel: a view carries no presentation state, and
 * `CommonModel` is a data vocabulary, not a presentation vocabulary
 * (docs/coreSpecs/RiaViews.md — P6). The catalog is what lets a renderer stop
 * hardcoding per-metamodel concept lists without either of those two rules
 * being broken.
 *
 * It follows the `view-queries.json` pattern exactly: a shipped JSON file read
 * on demand, optionally overridden whole-entry by a repository catalog. That
 * choice is deliberate — a graph table would cost a `SCHEMA_VERSION` bump and a
 * persistor round-trip extension, and a renderer-side constant could not be
 * read by anything outside the renderer.
 *
 * These types cross the IPC boundary, so they live in app-contracts.
 */

/**
 * How one concept of one metamodel is presented. Every field except `id`,
 * `metamodel`, and `concept` is a hint: a consumer that does not understand a
 * value falls back to its own default rather than failing.
 */
export interface ConceptPresentation {
  /** `"<METAMODEL>/<Concept>"`, e.g. `"COMMON_MODEL/ActiveElement"`. Primary key. */
  id: string;
  /** Metamodel name, e.g. `COMMON_MODEL`. */
  metamodel: string;
  /** Concept name within that metamodel, e.g. `ActiveElement`. */
  concept: string;
  /** Icon identifier the renderer resolves against its own icon set. */
  icon: string;
  /** Colour token, resolved by the consumer's theme — never a literal colour. */
  color: string;
  /** Node shape hint, e.g. `rectangle`, `rounded`, `circle`, `chevron-right`. */
  shape: string;
  /** Sort order among siblings. Lower sorts first. */
  order: number;
  /** Which attribute supplies the display label. Defaults to `name`. */
  labelAttribute: string;
  /** Attributes surfaced as badges beside the label, e.g. `["kind"]`. */
  badgeAttributes: string[];
}

/** Input for `presentation.get`. */
export interface GetPresentationInput {
  /** Metamodel whose concept entries to return, e.g. `COMMON_MODEL`. */
  metamodel: string;
}
