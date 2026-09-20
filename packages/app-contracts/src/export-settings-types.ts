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
 * Global (per-user, workspace-independent) preferences that shape safety
 * report exports.
 *
 * Persisted by `ExportSettingsStore` (app-core) as plaintext JSON under the
 * host-supplied `userDataDir`, alongside the LLM and cross-namespace-link
 * settings. Surfaced in the app Settings dialog under "Report Export".
 */
export interface ExportSettings {
  /**
   * Whether the semi-quantitative risk-rating values — Severity, Occurrence,
   * Detection and RPN — are written into exported reports.
   *
   * Defaults to `true` (the historical behaviour). Projects that do not use
   * the semi-quantitative rating scheme switch this off so the generated
   * report carries no half-filled rating line. The free-text risk-rating
   * note is unaffected: it is still exported, under its own field label.
   */
  includeRiskRatings: boolean;
}
