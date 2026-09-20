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
import type { ReviewExportData, SafetyDetailExportData } from '@riacore/app-contracts';

const flatten = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** Keep the same authored fields in the Excel cells and RST directive bodies. */
export function formatSotifDetails(details: SafetyDetailExportData[] = []): string {
  return details.map(detail => [
    `Name: ${flatten(detail.name)}`,
    `Description: ${flatten(detail.description)}`,
    `Source: ${flatten(detail.source)}`,
  ].join('\n')).join('\n\n');
}

export function formatReviews(reviews: ReviewExportData[] = []): string {
  return reviews.map(review => [
    `Title: ${flatten(review.name)}`,
    `Review Status: ${flatten(review.status)}`,
    `Verdict: ${flatten(review.verdict)}`,
    `Comment: ${flatten(review.reviewerComment)}`,
    `Author Status: ${flatten(review.authorStatus)}`,
    `Resolution: ${flatten(review.authorComment)}`,
  ].join('\n')).join('\n\n');
}
