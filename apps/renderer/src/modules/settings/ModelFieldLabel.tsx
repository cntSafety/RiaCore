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
import { InfoCircleOutlined } from '@ant-design/icons';
import { Button, Popover, Space } from 'antd';
import type { LlmProvider } from '@riacore/app-contracts';

export function ModelFieldLabel({ provider }: { provider: LlmProvider }) {
  return (
    <Space size={4}>
      <span>Model</span>
      <Popover
        trigger="click"
        content={
          <div style={{ maxWidth: 300 }}>
            {provider === 'ollama'
              ? 'Models are loaded from your local Ollama server. Pull a new model in Ollama, then refresh the list.'
              : 'These are model suggestions. To use a newer model that is not listed, type its exact model ID from your provider, then use Test Connection. No RiaCore update is needed for new IDs supported by the current integration.'}
          </div>
        }
      >
        <Button
          type="text"
          size="small"
          htmlType="button"
          aria-label="About model selection"
          icon={<InfoCircleOutlined />}
          onClick={event => event.preventDefault()}
        />
      </Popover>
    </Space>
  );
}
