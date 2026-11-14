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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { serializeRecord } from '../persistor/serializer.js';
import { writeFileAtomic } from '../persistor/persistor-helpers.js';
import type { SafetyOperation, SafetyRequestResult } from './safety-request.js';
export interface SafetyRequestReceipt { version: 1; key: string; digest: string; result: SafetyRequestResult }
export function requestKey(requestId: string): string {
  if (!requestId.trim() || requestId.length > 255) throw new Error('Request ID must contain 1–255 characters');
  return createHash('sha256').update(requestId).digest('hex');
}
export function requestDigest(operations: SafetyOperation[]): string {
  return createHash('sha256').update(serializeRecord({ operations }, ['operations'], [])).digest('hex');
}
export function readSafetyRequestReceipt(workingDir: string, requestId: string): SafetyRequestReceipt | null {
  const key = requestKey(requestId);
  const file = path.join(workingDir, '.ria-requests', `${key}.json`);
  if (!fs.existsSync(file)) return null;
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as SafetyRequestReceipt;
  if (receipt.version !== 1 || receipt.key !== key || typeof receipt.digest !== 'string' || receipt.result?.ok !== true) throw new Error('Invalid request receipt; preserve it for inspection');
  return receipt;
}
export function writeSafetyRequestReceipt(workingDir: string, receipt: SafetyRequestReceipt): void {
  if (!/^[a-f0-9]{64}$/.test(receipt.key) || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('Invalid request receipt identity');
  const directory = path.join(workingDir, '.ria-requests');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.gitignore'), '*\n');
  writeFileAtomic(path.join(directory, `${receipt.key}.json`), JSON.stringify(receipt));
}
